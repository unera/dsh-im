import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import React from 'react';

import { normalizeThinkingIntervalSeconds } from '../../../src/channels/shared/thinking-cadence.mjs';
import { TelegramConfigStore } from '../../../src/channels/telegram/config-store.mjs';
import { TelegramController } from '../../../src/channels/telegram/telegram-controller.mjs';
import { TelegramBotClient } from '../../../src/channels/telegram/telegram-runtime.mjs';
import { ThinkingTracesSettings } from '../../../plugin-src/client/channels/telegram/thinking-traces.js';
import { createTokenBotRpcHandler, TOKEN_BOT_ENDPOINTS } from '../../../plugin-src/host/channels/shared/rpc.mjs';
import { validThinkingCadencePayload } from '../../../plugin-src/host/channels/shared/thinking-cadence-rpc.mjs';

const TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123456';

const quietLogger = { warn: () => {}, error: () => {}, debug: () => {} };

const flush = () => new Promise((resolve) => { setImmediate(resolve); });

/** Advance the fake clock and let the promise chain the timer released run. */
async function advance(t, ms) {
  await flush();
  t.mock.timers.tick(ms);
  await flush();
}

function recorder() {
  const sent = [];
  const api = {
    sendMessage: async (params) => {
      sent.push(params.text);
      return { message_id: 5000 + sent.length };
    },
  };
  return { sent, api };
}

/** Stub API whose sends stay pending until the test releases them, so a test can
 *  ask which request is still on the wire at a given moment. */
function delayedRecorder() {
  const requested = [];
  const delivered = [];
  const api = {
    sendMessage: (params) => new Promise((resolve, reject) => {
      const request = {
        text: params.text,
        settled: false,
        deliver: () => {
          if (request.settled) return;
          request.settled = true;
          delivered.push(params.text);
          resolve({ message_id: 5000 + delivered.length });
        },
        fail: (error) => {
          if (request.settled) return;
          request.settled = true;
          reject(error);
        },
      };
      requested.push(request);
    }),
  };
  return { api, requested, delivered };
}

function credentials() {
  const values = new Map();
  return {
    async resolve(ref) {
      return values.has(ref) ? { value: values.get(ref), source: 'test' } : undefined;
    },
    async set(ref, value) { values.set(ref, value); },
    async unset(ref) { values.delete(ref); },
  };
}

async function controllerFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-thinking-cadence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'config.json');
  const configStore = await new TelegramConfigStore(configPath).load();
  const runtimeRecords = [];
  const controller = new TelegramController({
    credentials: credentials(),
    configStore,
    inspectToken: async () => ({
      platformId: '123456789', name: 'Harness Telegram', username: 'harness_bot',
    }),
    createRuntime: async ({ botId, config }) => {
      runtimeRecords.push({ botId, config: structuredClone(config) });
      return {
        status: { ready: true, connectionState: 'connected', harnessReachable: true, lastCheckedAt: 10 },
        async start() {},
        async stop() {},
      };
    },
  });
  const bound = await controller.bindCredentials({ token: TOKEN });
  return {
    configPath, configStore, controller, runtimeRecords, botId: bound.bots[0].botId,
  };
}

// --- frames on the wire ---------------------------------------------------

test('numbering counts paced-away frames, so the sent frames keep a gap in their numbers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { sent, api } = recorder();
  const client = new TelegramBotClient({
    api, signal: undefined, logger: quietLogger, thinkingNumbering: true, thinkingIntervalSeconds: 3,
  });
  const stream = client.openThinkingStream({ chatId: 42 });
  await stream.sendThinking('one');
  await advance(t, 1_000);
  await stream.sendThinking('two');
  await advance(t, 1_000);
  await stream.sendThinking('three');
  await advance(t, 1_000);
  assert.deepEqual(sent, ['1 💭 one', '3 💭 three'], 'frame 2 was paced away and never renumbered');
  await advance(t, 2_000);
  await stream.sendThinking('four');
  assert.deepEqual(sent, ['1 💭 one', '3 💭 three'], 'frame 4 waits for the rest of its window');
  await stream.finish('done');
  assert.deepEqual(sent.slice(0, 3), ['1 💭 one', '3 💭 three', '4 💭 four']);
  assert.equal(sent.at(-1), 'done');
});

test('a burst inside one window collapses to the newest frame only', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { sent, api } = recorder();
  const client = new TelegramBotClient({
    api, signal: undefined, logger: quietLogger, thinkingNumbering: true, thinkingIntervalSeconds: 3,
  });
  const stream = client.openThinkingStream({ chatId: 42 });
  await stream.sendThinking('first');
  await advance(t, 100);
  await stream.sendToolTrace('bash', { command: 'ls' });
  await advance(t, 100);
  await stream.sendThinking('third');
  assert.deepEqual(sent, ['1 💭 first'], 'nothing inside the window goes out immediately');
  await advance(t, 2_800);
  assert.deepEqual(sent, ['1 💭 first', '3 💭 third'], 'only the latest held frame is flushed');
  assert.ok(!sent.some((text) => text.includes('2 🔧')), 'the superseded frame is dropped, not queued');
});

test('finish() flushes the held frame before the final answer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { sent, api } = recorder();
  const client = new TelegramBotClient({
    api, signal: undefined, logger: quietLogger, thinkingNumbering: true, thinkingIntervalSeconds: 10,
  });
  const stream = client.openThinkingStream({ chatId: 42 });
  await stream.sendThinking('one');
  await advance(t, 1_000);
  await stream.sendThinking('two');
  assert.deepEqual(sent, ['1 💭 one']);
  await stream.finish('the answer');
  assert.deepEqual(sent, ['1 💭 one', '2 💭 two', 'the answer']);
});

test('a trace send that is still in flight settles before the final answer goes out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { api, requested, delivered } = delayedRecorder();
  const client = new TelegramBotClient({
    api, signal: undefined, logger: quietLogger, thinkingNumbering: true, thinkingIntervalSeconds: 5,
  });
  const stream = client.openThinkingStream({ chatId: 42 });
  const firstTrace = stream.sendThinking('one');
  await flush();
  await advance(t, 1_000);
  await stream.sendThinking('two');
  await advance(t, 5_000);
  assert.deepEqual(requested.map((request) => request.text), ['1 💭 one', '2 💭 two'],
    'the window timer flushed the held frame and left its send pending');
  const finishing = stream.finish('the answer');
  await flush();
  // The answer may not be requested while any trace request is unanswered, or
  // the trace lands in the chat after the reply that closes the turn.
  assert.deepEqual(requested.map((request) => request.text), ['1 💭 one', '2 💭 two'],
    'finish() waits for the in-flight trace sends instead of overtaking them');
  for (const request of requested) request.deliver();
  await flush();
  assert.deepEqual(requested.map((request) => request.text),
    ['1 💭 one', '2 💭 two', 'the answer'], 'the answer follows the last trace');
  requested.at(-1).deliver();
  const receipt = await finishing;
  await firstTrace;
  assert.deepEqual(delivered, ['1 💭 one', '2 💭 two', 'the answer']);
  assert.deepEqual(receipt.providerMessageIds, ['5001', '5002', '5003'],
    'the receipt knows every trace message the turn sent');
});

test('a trace request that fails does not cost the final answer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { api, requested } = delayedRecorder();
  const client = new TelegramBotClient({
    api, signal: undefined, logger: quietLogger, thinkingIntervalSeconds: 5,
  });
  const stream = client.openThinkingStream({ chatId: 42 });
  const trace = stream.sendThinking('one');
  await flush();
  const finishing = stream.finish('the answer');
  await flush();
  assert.deepEqual(requested.map((request) => request.text), ['💭 one'],
    'the answer still waits for the trace request it cannot know the fate of');
  requested[0].fail(new Error('telegram is down'));
  await flush();
  requested[1].deliver();
  const receipt = await finishing;
  await trace;
  assert.deepEqual(requested.map((request) => request.text), ['💭 one', 'the answer'],
    'a lost trace is best-effort and must not take the answer down with it');
  assert.equal(receipt.deliveryOutcome, 'sent');
  assert.deepEqual(receipt.providerMessageIds, ['5001']);
});

test('an update that lands after the deadline sends only the newest frame', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { sent, api } = recorder();
  const client = new TelegramBotClient({
    api, signal: undefined, logger: quietLogger, thinkingNumbering: true, thinkingIntervalSeconds: 5,
  });
  const stream = client.openThinkingStream({ chatId: 42 });
  await stream.sendThinking('one');
  await advance(t, 1_000);
  await stream.sendThinking('two');
  assert.deepEqual(sent, ['1 💭 one']);
  // The deadline passes while the held frame's timer is still queued, as it can
  // on a throttled or busy event loop, so the newer update sees the window
  // expired first.
  t.mock.timers.setTime(Date.now() + 5_000);
  await stream.sendThinking('three');
  assert.deepEqual(sent, ['1 💭 one', '3 💭 three'],
    'the frame that owns the fresh window goes out alone');
  await advance(t, 10_000);
  assert.deepEqual(sent, ['1 💭 one', '3 💭 three'],
    'the superseded timer must not deliver its stale frame afterwards');
});

test('cancel() drops the held frame and leaves no timer behind', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { sent, api } = recorder();
  const client = new TelegramBotClient({
    api, signal: undefined, logger: quietLogger, thinkingIntervalSeconds: 10,
  });
  const stream = client.openThinkingStream({ chatId: 42 });
  await stream.sendThinking('one');
  await advance(t, 1_000);
  await stream.sendThinking('two');
  stream.cancel();
  await advance(t, 30_000);
  assert.deepEqual(sent, ['💭 one'], 'the cancelled turn must not send the held frame later');
  await assert.rejects(() => stream.finish('answer'), /already closed/u);
});

test('numbering stays off by default, so a frame keeps exactly its formatted text', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { sent, api } = recorder();
  const client = new TelegramBotClient({ api, signal: undefined, logger: quietLogger });
  const stream = client.openThinkingStream({ chatId: 42 });
  await stream.sendThinking('Let me list the directory first.');
  await stream.sendToolTrace('bash', { command: 'ls -la' });
  await stream.finish('done');
  assert.deepEqual(sent, ['💭 Let me list the directory first.', '🔧 bash → ls -la', 'done']);
});

test('numbering works with pacing off and numbers every frame in order', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { sent, api } = recorder();
  const client = new TelegramBotClient({
    api, signal: undefined, logger: quietLogger, thinkingNumbering: true,
  });
  const stream = client.openThinkingStream({ chatId: 42 });
  await stream.sendThinking('one');
  await stream.sendThinking('two');
  await stream.sendToolTrace('bash', { command: 'pwd' });
  assert.deepEqual(sent, ['1 💭 one', '2 💭 two', '3 🔧 bash → pwd']);
});

// --- config: clamping, persistence, RPC -----------------------------------

test('thinkingIntervalSeconds normalizes to a whole 0..60, and garbage means no pacing', () => {
  assert.equal(normalizeThinkingIntervalSeconds(undefined), 0, 'missing means no pacing');
  assert.equal(normalizeThinkingIntervalSeconds(-5), 0);
  assert.equal(normalizeThinkingIntervalSeconds(99), 60);
  assert.equal(normalizeThinkingIntervalSeconds('7'), 7);
  assert.equal(normalizeThinkingIntervalSeconds(' 7 '), 7);
  assert.equal(normalizeThinkingIntervalSeconds('garbage'), 0);
  assert.equal(normalizeThinkingIntervalSeconds(7.5), 0, 'a fractional value must not slow the trace down');
  assert.equal(normalizeThinkingIntervalSeconds(true), 0);
  assert.equal(normalizeThinkingIntervalSeconds(null), 0);
});

test('the clamped cadence survives save and reload and reaches the runtime', async (t) => {
  const fixture = await controllerFixture(t);
  const saved = await fixture.controller.setThinkingCadence(fixture.botId, {
    thinkingNumbering: true,
    thinkingIntervalSeconds: 99,
  });
  assert.equal(saved.bots[0].thinkingNumbering, true);
  assert.equal(saved.bots[0].thinkingIntervalSeconds, 60, 'the status reports the clamped value');
  assert.equal(fixture.configStore.get(fixture.botId).thinkingIntervalSeconds, 60);
  assert.equal(fixture.runtimeRecords.at(-1).config.thinkingIntervalSeconds, 60,
    'the runtime restarts with the stored value');

  const reloaded = await new TelegramConfigStore(fixture.configPath).load();
  assert.equal(reloaded.get(fixture.botId).thinkingNumbering, true);
  assert.equal(reloaded.get(fixture.botId).thinkingIntervalSeconds, 60);

  const cleared = await fixture.controller.setThinkingCadence(fixture.botId, {
    thinkingNumbering: false,
    thinkingIntervalSeconds: 'nonsense',
  });
  assert.equal(cleared.bots[0].thinkingNumbering, false);
  assert.equal(cleared.bots[0].thinkingIntervalSeconds, 0);
});

test('the cadence RPC validates the payload shape and stores what the controller clamped', async (t) => {
  const fixture = await controllerFixture(t);
  const handler = createTokenBotRpcHandler(fixture.controller, { channel: 'Telegram' });
  assert.equal(TOKEN_BOT_ENDPOINTS.setThinkingCadence, 'bot.thinking-cadence.set');
  assert.equal(validThinkingCadencePayload({
    botId: fixture.botId, thinkingNumbering: true, thinkingIntervalSeconds: '99',
  }), true);
  assert.equal(validThinkingCadencePayload({
    botId: fixture.botId, thinkingNumbering: 'yes', thinkingIntervalSeconds: 5,
  }), false);
  assert.equal(validThinkingCadencePayload({ botId: fixture.botId, thinkingNumbering: true }), false);

  const rejected = await handler(TOKEN_BOT_ENDPOINTS.setThinkingCadence, {
    botId: fixture.botId, thinkingNumbering: true,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.message, '请提交有效的思考帧节奏设置。');

  const accepted = await handler(TOKEN_BOT_ENDPOINTS.setThinkingCadence, {
    botId: fixture.botId, thinkingNumbering: true, thinkingIntervalSeconds: '99',
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.value.bots[0].thinkingIntervalSeconds, 60);
  assert.equal(fixture.configStore.get(fixture.botId).thinkingIntervalSeconds, 60);
});

// --- client card ----------------------------------------------------------

test('the settings card renders the numbering switch and the interval select', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const calls = [];
  const markup = renderToStaticMarkup(React.createElement(ThinkingTracesSettings, {
    account: {
      botId: 'telegram_abc',
      thinkingTraces: true,
      thinkingNumbering: true,
      thinkingIntervalSeconds: 5,
    },
    rpcCall: async (endpoint, payload) => { calls.push({ endpoint, payload }); return { ok: true, value: {} }; },
    endpoints: { setThinkingCadence: 'bot.thinking-cadence.set' },
  }));
  assert.match(markup, /编号思考帧/);
  assert.match(markup, /最多每隔多久发送一帧（秒）/);
  assert.match(markup, /<select[^>]*class="dim-accountSettingsSelect"/);
  assert.match(markup, /<option value="0">不限制（0）<\/option>/);
  assert.match(markup, /<option value="5" selected="">5<\/option>/);
  assert.match(markup, /<option value="60">60<\/option>/);
  // Two switches now: thinking traces and frame numbering.
  assert.equal((markup.match(/type="checkbox"/g) ?? []).length, 2);
  assert.equal(calls.length, 0, 'rendering must not save anything');
});
