import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTextBridgeStatus,
  TextHarnessBridge,
} from '../../../src/channels/shared/text-harness-bridge.mjs';

function stateFixture() {
  const sessions = new Map();
  const seen = new Set();
  return {
    state: {
      sessionFor(key) { return sessions.get(key) ?? null; },
      async setSession(key, sessionId) {
        sessions.set(key, sessionId);
        return true;
      },
      async clearSession(key) { sessions.delete(key); },
      hasSeen(messageId) { return seen.has(messageId); },
      async markSeen(messageId) { seen.add(messageId); },
      async unmarkSeen(messageId) { return seen.delete(messageId); },
    },
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

/** A bridge whose bot can carry buttons, as Telegram does. */
function buttonBridge({ deliveryFails = 1, sentTexts } = {}) {
  const cards = [];
  const edits = [];
  const deletions = [];
  const acks = [];
  const deliveries = [];
  const texts = sentTexts ?? [];
  let failures = deliveryFails;
  const bridge = new TextHarnessBridge({
    descriptor: { key: 'telegram', label: 'Telegram' },
    state: stateFixture().state,
    status: createTextBridgeStatus(),
    bot: {
      sendText: async (_target, text) => {
        texts.push(text);
        return { providerMessageIds: ['900'] };
      },
      sendDelivery: async (_target, block) => {
        deliveries.push(block);
        if (failures > 0) {
          failures -= 1;
          const error = new Error('the send was never confirmed');
          error.code = 'channel-delivery-uncertain';
          error.deliveryOutcome = 'unknown';
          throw error;
        }
        return { providerMessageIds: ['901'], deliveryOutcome: 'sent' };
      },
      sendInteractionCard: async (_target, { text, markup }) => {
        cards.push({ text, markup });
        return { providerMessageIds: ['4242'] };
      },
      editInteractionCard: async (_target, messageId, { text, markup }) => {
        edits.push({ messageId, text, markup });
        return { providerMessageIds: [messageId] };
      },
      deleteMessage: async (_target, messageId) => {
        deletions.push(messageId);
      },
      answerInteractionCallback: async (callbackQueryId, notice) => {
        acks.push({ callbackQueryId, notice });
      },
    },
    harness: {
      sessionExists: async () => false,
      createSession: async () => 'session-failure-notice',
      ask: async () => 'потерянный ответ',
    },
    logger: { warn() {}, error() {} },
  });
  return { bridge, cards, edits, deletions, acks, deliveries, texts };
}

function press(card, index) {
  return {
    messageId: `press-${index}`,
    callbackQueryId: `query-${index}`,
    providerMessageId: 4242,
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-a',
    addressed: true,
    data: card.markup.inline_keyboard[0][index].callback_data,
    replyTarget: { chatId: 7 },
  };
}

test('an unconfirmed reply offers Resend and Delete instead of a dead notice', async () => {
  const { bridge, cards, texts } = buttonBridge();

  await bridge.accept(message('failure-one', '执行'));

  assert.equal(cards.length, 1, 'the failure notice must carry an inline keyboard');
  const buttons = cards[0].markup.inline_keyboard[0];
  assert.deepEqual(buttons.map((button) => button.text), ['重新发送', '删除']);
  assert.match(buttons[0].callback_data, /^fnote\|[A-Za-z0-9_-]+\|r$/u);
  assert.match(buttons[1].callback_data, /^fnote\|[A-Za-z0-9_-]+\|d$/u);
  assert.match(cards[0].text, /CHANNEL_DELIVERY_UNCERTAIN/u);
  assert.equal(texts.some((text) => text.includes('CHANNEL_DELIVERY_UNCERTAIN')), false,
    'the plain notice must not be sent twice');
});

test('Resend replays the lost reply and turns the notice into a receipt', async () => {
  const { bridge, cards, edits, deliveries, acks } = buttonBridge();

  await bridge.accept(message('failure-two', '执行'));
  await bridge.acceptCallback(press(cards[0], 0));

  assert.equal(deliveries.length, 2, 'the lost answer is delivered once more');
  assert.equal(deliveries[1].text, 'потерянный ответ');
  assert.equal(deliveries[1].format, 'markdown');
  assert.deepEqual(acks, [{ callbackQueryId: 'query-0', notice: '正在重新发送…' }]);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].messageId, '4242');
  assert.equal(edits[0].text, '已重新发送。');
  assert.deepEqual(edits[0].markup.inline_keyboard, [], 'a used notice loses its buttons');
});

test('a second failed resend keeps both buttons', async () => {
  const { bridge, cards, edits, acks } = buttonBridge({ deliveryFails: 2 });

  await bridge.accept(message('failure-three', '执行'));
  await bridge.acceptCallback(press(cards[0], 0));

  assert.equal(edits.length, 1);
  assert.equal(edits[0].text, '再次发送失败，稍后再试。');
  assert.equal(edits[0].markup.inline_keyboard[0].length, 2, 'the user can press again');
  assert.deepEqual(acks, [{ callbackQueryId: 'query-0', notice: '正在重新发送…' }]);
});

test('Delete removes the notice itself and forgets the lost reply', async () => {
  const { bridge, cards, deletions, edits, acks } = buttonBridge();

  await bridge.accept(message('failure-four', '执行'));
  await bridge.acceptCallback(press(cards[0], 1));

  assert.deepEqual(acks, [{ callbackQueryId: 'query-1', notice: '已删除。' }]);
  assert.deepEqual(deletions, ['4242']);
  assert.deepEqual(edits, []);
  // The second press on a deleted notice can no longer replay the reply.
  await bridge.acceptCallback(press(cards[0], 0));
  assert.equal(acks.at(-1).notice, '这条通知已失效。');
});

test('a channel without inline keyboards keeps the plain notice', async () => {
  const sentTexts = [];
  const bridge = new TextHarnessBridge({
    descriptor: { key: 'wecom-app', label: 'WeCom' },
    state: stateFixture().state,
    status: createTextBridgeStatus(),
    bot: {
      sendText: async (_target, text) => {
        sentTexts.push(text);
        return { providerMessageIds: ['1'] };
      },
      sendDelivery: async () => {
        const error = new Error('unconfirmed');
        error.deliveryOutcome = 'unknown';
        throw error;
      },
    },
    harness: {
      sessionExists: async () => false,
      createSession: async () => 'session-plain-notice',
      ask: async () => 'потерянный ответ',
    },
    logger: { warn() {}, error() {} },
  });

  await bridge.accept(message('failure-five', '执行'));

  assert.equal(sentTexts.length, 1);
  assert.match(sentTexts[0], /CHANNEL_DELIVERY_UNCERTAIN/u);
});
