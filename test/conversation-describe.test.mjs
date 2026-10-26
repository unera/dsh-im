import assert from 'node:assert/strict';
import test from 'node:test';

import { parseConversationKey } from '../src/channels/shared/conversation/describe.mjs';
import { createDeliveryAdapter } from '../plugin-src/host/delivery-adapter.mjs';

/** Minimal workspace store: only the calls describeConversationBySession makes. */
function fakeWorkspaces(botIds) {
  return {
    listBotIds: () => [...botIds],
    has: (botId) => botIds.includes(botId),
  };
}

function fakeState(sessionsByBot) {
  return async (botId) => {
    const sessions = sessionsByBot[botId];
    if (!sessions) throw new Error(`no state for ${botId}`);
    return { snapshot: () => ({ sessions }) };
  };
}

function adapterWith({ botIds = ['botA'], sessionsByBot, accounts = {} }) {
  return createDeliveryAdapter({
    channel: 'telegram',
    workspaces: fakeWorkspaces(botIds),
    coreController: {
      describeDeliveryAccount: async (botId) => accounts[botId] ?? { name: null },
    },
    stateFor: fakeState(sessionsByBot),
  });
}

test('a group without a thread yields the chat id only', () => {
  assert.deepEqual(parseConversationKey('group:-1004337494578'), {
    chatType: 'group', chatId: '-1004337494578', threadId: null, senderId: null,
  });
});

test('a telegram forum topic yields chat id and thread id', () => {
  assert.deepEqual(parseConversationKey('group:-1004337494578:64'), {
    chatType: 'thread', chatId: '-1004337494578', threadId: '64', senderId: null,
  });
});

test('a feishu thread keeps both ids', () => {
  assert.deepEqual(parseConversationKey('group:oc_abc:thread:om_1'), {
    chatType: 'thread', chatId: 'oc_abc', threadId: 'om_1', senderId: null,
  });
});

test('a matrix room thread splits on the dollar sign', () => {
  assert.deepEqual(parseConversationKey('group:room:!a:x.org$$root:y.org'), {
    chatType: 'thread', chatId: '!a:x.org', threadId: '$root:y.org', senderId: null,
  });
});

test('a direct chat carries the sender id', () => {
  assert.deepEqual(parseConversationKey('direct:161161619'), {
    chatType: 'dm', chatId: null, threadId: null, senderId: '161161619',
  });
  assert.deepEqual(parseConversationKey('direct:dm:161161619'), {
    chatType: 'dm', chatId: null, threadId: null, senderId: '161161619',
  });
});

test('an unknown shape is not guessed', () => {
  for (const key of [null, undefined, '', 'group:', 'direct:', 'channel:1', 42]) {
    assert.equal(parseConversationKey(key), null, `expected null for ${String(key)}`);
  }
});

test('the adapter finds the conversation that owns a session', async () => {
  const adapter = adapterWith({
    sessionsByBot: { botA: { 'group:-100:64': 'session-1' } },
    accounts: { botA: { name: 'DSH Assistant' } },
  });
  const described = await adapter.describeConversationBySession('session-1');
  assert.equal(described.channel, 'telegram');
  assert.equal(described.botId, 'botA');
  assert.equal(described.botName, 'DSH Assistant');
  assert.equal(described.conversationKey, 'group:-100:64');
  assert.equal(described.chatType, 'thread');
  assert.equal(described.chatId, '-100');
  assert.equal(described.threadId, '64');
  assert.equal(described.senderId, null);
});

test('an unknown session is null, not an error', async () => {
  const adapter = adapterWith({ sessionsByBot: { botA: { 'group:-100': 'session-1' } } });
  assert.equal(await adapter.describeConversationBySession('session-other'), null);
  assert.equal(await adapter.describeConversationBySession(''), null);
  assert.equal(await adapter.describeConversationBySession(undefined), null);
});

test('a channel whose state cannot be read does not break the lookup', async () => {
  const adapter = adapterWith({ botIds: ['broken', 'botA'], sessionsByBot: { botA: { 'direct:1': 'session-9' } } });
  const described = await adapter.describeConversationBySession('session-9');
  assert.equal(described.botId, 'botA');
  assert.equal(described.chatType, 'dm');
  assert.equal(described.senderId, '1');
});

test('a missing account name does not throw', async () => {
  const adapter = createDeliveryAdapter({
    channel: 'telegram',
    workspaces: fakeWorkspaces(['botA']),
    coreController: {},
    stateFor: fakeState({ botA: { 'group:1': 'session-1' } }),
  });
  const described = await adapter.describeConversationBySession('session-1');
  assert.equal(described.botName, null);
  assert.equal(described.chatId, '1');
});
