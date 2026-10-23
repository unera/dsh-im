import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modernHarnessApi } from '../plugin-src/host/modern-harness-api.mjs';
import { createDeliveryAdapter } from '../plugin-src/host/delivery-adapter.mjs';
import { DeliveryService } from '../plugin-src/host/delivery-service.mjs';
import { BotWorkspaceStore } from '../src/channels/shared/bot-workspace-store.mjs';
import { ConversationStateStore } from '../src/channels/shared/conversation-state-store.mjs';
import { FeishuRuntime } from '../src/channels/feishu/feishu-runtime.mjs';
import { MultiBotDshFeishuController } from '../src/channels/feishu/multi-bot-controller.mjs';
import { directAccessPolicy } from './channels/access-policy-fixture.mjs';
import { installDsBotQuestionSync } from '../plugin-src/host/ds-bot-question-sync.mjs';

const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
async function until(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('expected question delivery/answer did not arrive');
    await flush();
  }
}
const questions = [{ id: 'choice', question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }];
const answer = { answers: [{ id: 'choice', selected: ['Yes'] }] };

// Real Host adapter, binding store, delivery service, controller and Feishu runtime.
// Only the native question UI, Harness backend and Feishu SDK transport are faked.
async function fixture(t, { failCards = false, failText = false, sendGate } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-bound-question-'));
  const workspaces = await new BotWorkspaceStore(join(dir, 'workspaces.json'), { defaultWorkspace: dir }).load();
  await workspaces.ensure('im-one');
  const state = await new ConversationStateStore(join(dir, 'state.json')).load();
  const key = 'p2p:ou_user';
  await state.setSession(key, 'old-session');
  let bot = { id: 'ds-one', name: 'Bound Bot', sessionId: 'bot-session' };
  let botQuestion = null;
  const botAnswers = [];
  const dsBot = {
    async status() { return { state: 'ready', bots: [bot] }; },
    async resolve(id) { assert.equal(id, bot.id); return bot; },
    async question(id) { return id === bot.sessionId ? botQuestion : null; },
    async answerQuestion(sessionId, questionId, value) {
      if (sessionId !== bot.sessionId || botQuestion?.id !== questionId) {
        throw Object.assign(new Error('This question is no longer open'), { code: 'interaction-not-pending' });
      }
      botQuestion = null;
      botAnswers.push({ sessionId, questionId, answer: value });
    },
  };
  const sent = [], patches = [], prompts = [], offers = [], attempts = [];
  let handlers;
  const sdk = {
    Domain: { Feishu: 'feishu', Lark: 'lark' }, LoggerLevel: { info: 'info' },
    Client: class {
      constructor() {
        const send = async (request) => {
          attempts.push(request);
          await sendGate?.promise;
          if (failCards && request.data.msg_type === 'interactive') throw new Error('card unavailable');
          if (failText && request.data.msg_type === 'text') throw new Error('text unavailable');
          sent.push(request);
          return { code: 0, data: { message_id: `message-${sent.length}`, chat_id: 'oc_chat' } };
        };
        this.im = { v1: { message: { create: send, reply: send,
          patch: async (request) => { patches.push(request); return { code: 0 }; },
        } } };
      }
    },
    EventDispatcher: class { register(value) { handlers = value; return this; } },
    WSClient: class {
      constructor(options) { this.options = options; }
      async start() { this.options.onReady(); }
      getConnectionStatus() { return { state: 'connected' }; }
      close() {}
    },
  };
  const policy = directAccessPolicy({ users: [{ id: 'ou_user' }] });
  const runtime = new FeishuRuntime({
    lark: sdk, botId: 'im-one', appId: 'test', appSecret: 'test', ownerOpenIds: ['ou_user'],
    state, accessPolicy: policy, slashCommands: false,
    logger: { warn() {}, error() {}, info() {} },
    harness: {
      async ensureRunning() {}, async sessionExists() { return true; },
      async ask(...args) { prompts.push(args); return 'ordinary answer'; },
    },
  });
  const config = { id: 'im-one', appId: 'test', secretRef: 'test', ownerOpenIds: ['ou_user'] };
  const controller = new MultiBotDshFeishuController({
    registerApp() {}, verifyApp: async () => ({ name: 'test', openId: 'ou_bot', activated: 1 }),
    credentials: { resolve: async () => ({ value: 'test' }) },
    configStore: { list: () => [config], getBot: () => config, saveBot: async () => config },
    createRuntime: async () => runtime, logger: { warn() {}, error() {}, info() {} },
  });
  const service = new DeliveryService({ dsBot });
  service.registerAdapter(createDeliveryAdapter({ channel: 'feishu', workspaces, dsBot,
    stateFor: async () => state, coreController: controller,
  }));
  const listeners = new Map();
  const ctx = { root: {}, typertGateway: { invoke() {}, stream() {} },
    on(event, fn) { listeners.set(event, fn); return () => listeners.delete(event); },
  };
  const api = modernHarnessApi(ctx, { deliveryService: service });
  const deliver = service.presentSessionSyncQuestion?.bind(service);
  if (deliver) service.presentSessionSyncQuestion = async (...args) => { offers.push(args); return deliver(...args); };
  t.after(async () => { api.dispose(); await controller.close(); await rm(dir, { recursive: true, force: true }); });
  await controller.initialize();
  assert.equal(runtime.status.ready, true);
  await service.bindDsBot('im-one', key, bot.id);
  const frames = [];
  const mux = api.events.mux({});
  void (async () => { for await (const frame of mux) frames.push(frame); })();
  let messageSequence = 0;
  return {
    service, workspaces, state, runtime, key, sent, patches, prompts, offers, frames, policy, attempts,
    botAnswers,
    setBotQuestion(question) { botQuestion = question; },
    startBotSync() {
      let onEvent;
      const sync = installDsBotQuestionSync({ on(_type, fn) { onEvent = fn; return () => {}; } }, service);
      t.after(() => sync.close());
      return { ...sync, event(type) { onEvent({ id: bot.sessionId }, { type }); } };
    },
    rollover() { bot = { ...bot, sessionId: 'next-session', parts: ['bot-session'] }; },
    ask({ origin = 'desktop', items = questions, native = deferred() } = {}) {
      const turn = new AbortController();
      const events = [{ type: 'turn/start', seq: 0, data: { turn: 2 } }];
      if (origin === 'desktop') events.push({ type: 'user/message', seq: 1,
        data: { turn: 2, source: { kind: 'user', rpcId: 'desktop-prompt' } },
      });
      const request = { agent: { session: { id: bot.sessionId, snapshotEvents: () => events } },
        questions: items, signal: turn.signal,
      };
      const result = listeners.get('user-questions/request')(request, () => native.promise);
      void result.catch(() => {});
      return { result, request, turn, native };
    },
    text(text, extra = {}) {
      handlers['im.message.receive_v1']({
        sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } },
        message: { message_id: `incoming-${++messageSequence}`, chat_type: 'p2p', chat_id: 'oc_chat',
          message_type: 'text', content: JSON.stringify({ text }), ...extra },
      });
    },
    click(id, { actor = 'ou_user', messageId = 'message-1', index = 0, label = 'Yes' } = {}) {
      handlers['card.action.trigger']({
        event_id: `callback-${++messageSequence}`, operator: { open_id: actor },
        context: { open_message_id: messageId, open_chat_id: 'oc_chat' },
        action: { value: { action: `answer:${id}:${index}:${label}` } },
      });
    },
  };
}

for (const origin of ['desktop', 'goal']) {
  for (const reply of ['number', 'button']) {
    test(`#421: DS Bot ${origin} question is answered by Feishu ${reply} without an IM prompt`, async (t) => {
      const f = await fixture(t);
      const q = f.ask({ origin });
      await until(() => f.sent.length === 1);
      assert.equal(f.sent[0].params.receive_id_type, 'open_id');
      assert.equal(f.sent[0].data.receive_id, 'ou_user');
      assert.equal(f.sent[0].data.msg_type, 'interactive');
      assert.equal(f.frames.length, 0, 'bound questions must not be broadcast to other IM watchers');
      if (reply === 'number') f.text('1');
      else f.click(f.offers[0][1].interactionId);
      assert.deepEqual(await q.result, answer);
      await until(() => f.patches.length === 1);
      assert.equal(q.turn.signal.aborted, false, 'answering must not abort a waiting PTC/agent turn');
      assert.equal(q.request.signal.aborted, true, 'the losing native card is retired');
      assert.equal(f.prompts.length, 0, 'the reply is an answer, not next-turn input');
      assert.equal(f.offers.length, 1);
    });
  }
}

test('a bound question falls back to text, accepts multiple answers and keeps its reply route', async (t) => {
  const f = await fixture(t, { failCards: true });
  const q = f.ask({ items: [...questions, { id: 'note', question: 'Any details?' }] });
  await until(() => f.sent.length === 1);
  assert.equal(f.sent[0].data.msg_type, 'text');
  assert.equal(f.sent[0].params.receive_id_type, 'open_id');
  f.text('1');
  await until(() => f.sent.length === 2);
  assert.equal(f.sent[1].params.receive_id_type, 'chat_id');
  assert.equal(f.sent[1].data.receive_id, 'oc_chat');
  f.text('Use the staging environment');
  assert.deepEqual(await q.result, { answers: [...answer.answers,
    { id: 'note', selected: [], custom: 'Use the staging environment' },
  ] });
  assert.equal(f.prompts.length, 0);
});

for (const reason of ['desktop-answer', 'turn-cancel', 'unbind', 'rebind', 'runtime-stop']) {
  test(`bound question retires after ${reason} and refuses late answers`, async (t) => {
    const f = await fixture(t);
    const q = f.ask();
    await until(() => f.sent.length === 1);
    const interaction = f.offers[0][1];
    if (reason === 'desktop-answer') q.native.resolve(answer);
    else if (reason === 'turn-cancel') q.turn.abort();
    else if (reason === 'runtime-stop') await f.runtime.stop();
    else {
      await f.service.unbindDsBot('im-one', f.key);
      if (reason === 'rebind') {
        f.rollover();
        await f.service.bindDsBot('im-one', f.key, 'ds-one');
      }
      f.text('1');
      await until(() => f.sent.length > 1);
    }
    if (reason === 'turn-cancel') await assert.rejects(q.result, { code: 'ASK_ABORTED' });
    else {
      q.native.resolve(answer);
      assert.deepEqual(await q.result, answer, 'losing the IM route must keep the desktop answer usable');
      assert.equal(q.turn.signal.aborted, false);
    }
    await assert.rejects(interaction.respond({ ok: true,
      value: { sessionId: 'bot-session', answer },
    }), { code: 'interaction-not-pending' });
    if (reason === 'desktop-answer') {
      f.click(interaction.interactionId);
      await until(() => f.sent.length > 1);
      assert.equal(f.prompts.length, 0, 'a stale button never becomes a prompt');
      const next = f.ask();
      await until(() => f.offers.length === 2 && f.sent.some((item, i) => i > 0 && item.data.msg_type === 'interactive'));
      f.text('1');
      assert.deepEqual(await next.result, answer, 'the retired question must not occupy the private chat');
    }
    assert.equal(f.prompts.length, 0);
  });
}

test('a goal question remains answerable on IM when no native provider is connected', async (t) => {
  const f = await fixture(t);
  const native = deferred();
  const q = f.ask({ origin: 'goal', native });
  native.reject(Object.assign(new Error('no desktop'), { code: 'NO_PROVIDER' }));
  await until(() => f.sent.length === 1);
  f.text('1');
  assert.deepEqual(await q.result, answer);
});

test('no binding and no native provider preserves NO_PROVIDER instead of hanging', async (t) => {
  const f = await fixture(t);
  await f.service.unbindDsBot('im-one', f.key);
  const native = deferred();
  const q = f.ask({ native });
  native.reject(Object.assign(new Error('no desktop'), { code: 'NO_PROVIDER' }));
  await assert.rejects(q.result, { code: 'NO_PROVIDER' });
  assert.equal(f.sent.length, 0);
});

test('failed card and text delivery leaves desktop usable and clears the failed IM pending', async (t) => {
  const f = await fixture(t, { failCards: true, failText: true });
  const q = f.ask();
  await until(() => f.attempts.length === 3); // card, text fallback, desktop notice
  await flush();
  q.native.resolve(answer);
  assert.deepEqual(await q.result, answer);
  assert.equal(q.turn.signal.aborted, false);
});

test('desktop can answer while binding lookup is pending, without a late question delivery', async (t) => {
  const f = await fixture(t);
  const gate = deferred();
  const list = f.service.listSessionSyncTargets.bind(f.service);
  f.service.listSessionSyncTargets = async (id) => { await gate.promise; return list(id); };
  const q = f.ask();
  await until(() => f.offers.length === 1);
  q.native.resolve(answer);
  assert.deepEqual(await q.result, answer);
  gate.resolve();
  await flush();
  await flush();
  assert.equal(f.sent.length, 0);
});

test('cancellation during card delivery does not resurrect an answerable question', async (t) => {
  const gate = deferred();
  const f = await fixture(t, { sendGate: gate });
  const q = f.ask();
  await until(() => f.attempts.length === 1);
  q.turn.abort();
  await assert.rejects(q.result, { code: 'ASK_ABORTED' });
  gate.resolve();
  await until(() => f.sent.length === 1);
  await flush();
  f.click(f.offers[0][1].interactionId);
  await until(() => f.sent.length === 2);
  assert.equal(f.prompts.length, 0);
  const next = f.ask();
  await until(() => f.sent.length === 3);
  f.text('1');
  assert.deepEqual(await next.result, answer);
});

test('IM withdrawal followed by native failure rejects instead of waiting forever', async (t) => {
  const f = await fixture(t);
  const q = f.ask();
  await until(() => f.sent.length === 1);
  await f.runtime.stop();
  q.native.reject(Object.assign(new Error('no desktop'), { code: 'NO_PROVIDER' }));
  await assert.rejects(q.result, { code: 'NO_PROVIDER' });
});

test('only the bound, currently allowed actor can answer a synced question', async (t) => {
  const f = await fixture(t);
  const q = f.ask();
  await until(() => f.sent.length === 1);
  f.click(f.offers[0][1].interactionId, { actor: 'ou_other' });
  await flush();
  assert.equal(f.patches.length, 0);
  f.text('1');
  assert.deepEqual(await q.result, answer);
});

for (const origin of ['desktop', 'automatic', 'restart']) {
  test(`#421: DS Bot ask_user from ${origin} delivers a card and resumes through DS Bot's answer route`, async (t) => {
    const f = await fixture(t);
    if (origin === 'restart') f.setBotQuestion(questions[0]);
    const sync = f.startBotSync();
    await sync.ready;
    if (origin !== 'restart') {
      f.setBotQuestion(questions[0]);
      sync.event('turn/end');
    }
    await until(() => f.sent.length === 1);
    await sync.refresh();
    assert.equal(f.sent[0].data.msg_type, 'interactive');
    assert.equal(f.sent.length, 1, 'repeated events must not duplicate the question');
    const interaction = f.offers[0][1];
    if (origin === 'automatic') f.text('1');
    else f.click(interaction.interactionId);
    await until(() => f.patches.length === 1);
    assert.deepEqual(f.botAnswers, [{ sessionId: 'bot-session', questionId: 'choice', answer: answer.answers[0] }]);
    assert.equal(f.prompts.length, 0, 'DS Bot owns the follow-up; do not send an unrelated IM prompt');
    await assert.rejects(interaction.respond({ ok: true, value: { sessionId: 'bot-session', answer } }), { code: 'interaction-not-pending' });
  });
}

for (const reason of ['desktop-answer', 'desktop-dismiss', 'replacement', 'unbind', 'rollover', 'dispose']) {
  test(`DS Bot ask_user refuses an old Feishu card after ${reason}`, async (t) => {
    const f = await fixture(t);
    f.setBotQuestion(questions[0]);
    const sync = f.startBotSync();
    await sync.ready;
    assert.equal(f.sent[0].data.msg_type, 'interactive');
    const interaction = f.offers[0][1];
    if (reason === 'unbind') await f.service.unbindDsBot('im-one', f.key);
    else if (reason === 'rollover') f.rollover();
    else if (reason === 'dispose') sync.close();
    else f.setBotQuestion(reason === 'replacement' ? { ...questions[0], id: 'next' } : null);
    if (reason === 'desktop-answer') {
      sync.event('user/message');
      await sync.refresh();
    }
    f.click(interaction.interactionId);
    await flush();
    await sync.refresh();
    await until(() => f.sent.length > 1 || f.offers[0][2].signal.aborted);
    assert.equal(f.botAnswers.length, 0);
    assert.equal(f.prompts.length, 0);
  });
}
