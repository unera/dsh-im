import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTextBridgeStatus,
  TextHarnessBridge,
} from '../../../src/channels/shared/text-harness-bridge.mjs';

const PROMPT_ID = 'im-cadence-test-1';

function stateFixture() {
  // The chat is already bound, so a press needs no turn to run first.
  const sessions = new Map([['direct:chat-a', 'session-cadence']]);
  const seen = new Set();
  return {
    sessionFor: (key) => sessions.get(key) ?? null,
    setSession: async (key, value) => {
      sessions.set(key, value);
      return true;
    },
    clearSession: async (key) => { sessions.delete(key); },
    hasSeen: (id) => seen.has(id),
    markSeen: async (id) => { seen.add(id); },
    unmarkSeen: async (id) => { seen.delete(id); },
  };
}

function message(messageId, content) {
  return {
    messageId,
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-a',
    content,
    addressed: true,
    replyTarget: { id: `target-${messageId}`, chatId: 7 },
  };
}

function historyEvents({ ended = true } = {}) {
  const events = [
    {
      seq: 1,
      time: 1_000,
      type: 'user/message',
      data: { turn: 3, source: { kind: 'user', rpcId: PROMPT_ID }, content: [{ type: 'text', text: '执行' }] },
    },
    { seq: 2, time: 1_100, type: 'turn/start', data: { turn: 3 } },
    {
      seq: 3,
      time: 1_200,
      type: 'assistant/message',
      data: { turn: 3, message: { content: [{ type: 'text', text: 'готовый ответ хода' }] } },
    },
  ];
  if (ended) events.push({ seq: 4, time: 1_300, type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } });
  return events;
}

/**
 * A bridge over a thinking-trace channel: the bot opens a cadence stream, the
 * Session answers from a fixed ledger, and every keyboard the bridge puts on a
 * cadence frame is recorded.
 */
function cadenceBridge({ ended = true, deliveryFails = 0 } = {}) {
  const opened = [];
  const deliveries = [];
  const texts = [];
  const acks = [];
  const keyboards = [];
  let failures = deliveryFails;
  const events = historyEvents({ ended });
  let promptRpcId = null;
  const bridge = new TextHarnessBridge({
    descriptor: { key: 'telegram', label: 'Telegram' },
    state: stateFixture(),
    status: createTextBridgeStatus(),
    thinkingTraces: true,
    bot: {
      sendText: async (_target, text) => {
        texts.push(text);
        return { providerMessageIds: ['500'] };
      },
      sendDelivery: async (_target, block) => {
        deliveries.push(block);
        if (failures > 0) {
          failures -= 1;
          return { deliveryOutcome: 'failed', reason: 'offline' };
        }
        return { providerMessageIds: ['501'], deliveryOutcome: 'sent' };
      },
      openThinkingStream: async (_target, options) => {
        opened.push(options);
        return {
          presentation: 'telegram-thinking',
          keepalive: true,
          messageId: 4242,
          providerMessageIds: [],
          update: async () => {},
          sendThinking: async () => {},
          sendToolTrace: async () => {},
          finish: async () => ({ providerMessageIds: ['700'], deliveryOutcome: 'sent' }),
          cancel: () => {},
        };
      },
      sendInteractionCard: async () => ({ providerMessageIds: ['4242'] }),
      updateInteractionCard: async (_target, messageId, payload) => {
        keyboards.push({ messageId, ...payload });
        return { providerMessageIds: [String(messageId)] };
      },
      answerInteractionCallback: async (callbackQueryId, notice) => {
        acks.push({ callbackQueryId, notice });
      },
    },
    harness: {
      sessionExists: async () => false,
      createSession: async () => 'session-cadence',
      newPromptRpcId: () => PROMPT_ID,
      // A bound Session handle: one ledger page in the shape `session.history`
      // returns it, plus the ask the bridge submits the prompt through.
      workspaceSession: (_sessionId, _key) => ({
        sessionExists: async () => true,
        readHistory: async () => ({ events: events.map((event) => ({ event })), hasMore: false }),
        ask: async (_prompt, options = {}) => {
          promptRpcId = options.promptRpcId ?? null;
          return 'ответ модели';
        },
      }),
      ask: async () => 'ответ модели',
    },
    logger: { warn() {}, error() {} },
  });
  return { bridge, opened, deliveries, texts, acks, keyboards, promptId: () => promptRpcId };
}

function press(data) {
  return {
    messageId: '4242',
    callbackQueryId: 'query-1',
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-a',
    addressed: true,
    data,
    replyTarget: { chatId: 7 },
  };
}

test('every cadence frame carries a button for its own turn', async () => {
  const { bridge, opened, promptId } = cadenceBridge();

  await bridge.accept(message('cadence-one', '执行'));

  assert.equal(opened.length, 1, 'the turn runs through the cadence stream');
  assert.deepEqual(opened[0].traceMarkup.inline_keyboard, [[{
    text: '重新发送这一轮的答复',
    callback_data: `cad|${PROMPT_ID}`,
  }]]);
  assert.equal(promptId(), PROMPT_ID, 'the button names the prompt the turn is submitted under');
});

test('a channel without inline keyboards gets no cadence button', async () => {
  const opened = [];
  const bridge = new TextHarnessBridge({
    descriptor: { key: 'wecom-app', label: 'WeCom' },
    state: stateFixture(),
    status: createTextBridgeStatus(),
    thinkingTraces: true,
    bot: {
      sendText: async () => ({ providerMessageIds: ['1'] }),
      openThinkingStream: async (_target, options) => {
        opened.push(options);
        return {
          keepalive: true,
          update: async () => {},
          sendThinking: async () => {},
          sendToolTrace: async () => {},
          finish: async () => ({ providerMessageIds: ['2'], deliveryOutcome: 'sent' }),
          cancel: () => {},
        };
      },
    },
    harness: {
      sessionExists: async () => false,
      createSession: async () => 'session-cadence',
      newPromptRpcId: () => PROMPT_ID,
      ask: async () => 'ответ модели',
    },
    logger: { warn() {}, error() {} },
  });

  await bridge.accept(message('cadence-plain', '执行'));

  assert.deepEqual(opened, [undefined], 'no keyboard is ever attached');
});

test('pressing the frame mid-turn says the turn is still running', async () => {
  const { bridge, acks, deliveries, texts } = cadenceBridge({ ended: false });

  await bridge.acceptCallback(press(`cad|${PROMPT_ID}`));

  assert.deepEqual(acks, [{ callbackQueryId: 'query-1', notice: '正在查找这一轮的答复…' }]);
  assert.deepEqual(deliveries, [], 'no answer exists yet');
  assert.deepEqual(texts, ['这一轮还在进行中，等它结束后再按一次。']);
});

test('pressing the frame after the turn resends that turn\'s answer', async () => {
  const { bridge, acks, deliveries, keyboards } = cadenceBridge();

  await bridge.acceptCallback(press(`cad|${PROMPT_ID}`));

  assert.deepEqual(acks, [{ callbackQueryId: 'query-1', notice: '正在查找这一轮的答复…' }]);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].text, 'готовый ответ хода');
  assert.equal(deliveries[0].format, 'markdown');
  assert.deepEqual(keyboards, [{
    messageId: '4242',
    markup: { inline_keyboard: [] },
  }], 'a used frame loses its button');
});

test('a resend that fails leaves the button in place', async () => {
  const { bridge, deliveries, keyboards, texts } = cadenceBridge({ deliveryFails: 1 });

  await bridge.acceptCallback(press(`cad|${PROMPT_ID}`));

  assert.equal(deliveries.length, 1);
  assert.deepEqual(keyboards, [], 'the button stays: a second press may land');
  assert.deepEqual(texts, ['再次发送失败，稍后再试。']);
});

test('a turn that ended without text reports no answer', async () => {
  const texts = [];
  const events = [
    {
      seq: 1,
      type: 'user/message',
      data: { turn: 4, source: { kind: 'user', rpcId: PROMPT_ID }, content: [] },
    },
    { seq: 2, type: 'turn/start', data: { turn: 4 } },
    { seq: 3, type: 'turn/end', data: { turn: 4, reason: { kind: 'cancelled' } } },
  ];
  const failing = new TextHarnessBridge({
    descriptor: { key: 'telegram', label: 'Telegram' },
    state: stateFixture(),
    status: createTextBridgeStatus(),
    thinkingTraces: true,
    bot: {
      sendText: async (_target, text) => { texts.push(text); return { providerMessageIds: ['1'] }; },
      answerInteractionCallback: async (_id, notice) => { texts.push(notice); },
    },
    harness: {
      sessionExists: async () => true,
      createSession: async () => 'session-cadence',
      workspaceSession: () => ({
        sessionExists: async () => true,
        readHistory: async () => ({ events: events.map((event) => ({ event })), hasMore: false }),
      }),
      ask: async () => 'ответ модели',
    },
    logger: { warn() {}, error() {} },
  });

  await failing.acceptCallback(press(`cad|${PROMPT_ID}`));

  assert.deepEqual(texts, ['正在查找这一轮的答复…', '这一轮没有可用的文字答复。']);
});
