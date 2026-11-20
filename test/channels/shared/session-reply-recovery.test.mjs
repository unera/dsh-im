import assert from 'node:assert/strict';
import test from 'node:test';

import {
  recoverAssistantTextByPromptRpcId,
} from '../../../src/channels/shared/session-reply-recovery.mjs';

function sessionOf(pages) {
  const calls = [];
  return {
    calls,
    session: {
      async readHistory(request) {
        calls.push(request);
        const page = pages[Math.min(calls.length - 1, pages.length - 1)];
        return { events: page.map((event) => ({ event })), hasMore: calls.length < pages.length };
      },
    },
  };
}

function turnEvents({ rpcId = 'im-1', turn = 1, answer = 'ответ', end = 'completed', withAnswer = true } = {}) {
  const events = [
    { seq: 1, type: 'user/message', data: { turn, source: { kind: 'user', rpcId } } },
    { seq: 2, type: 'turn/start', data: { turn } },
  ];
  if (withAnswer) {
    events.push({
      seq: 3,
      type: 'assistant/message',
      data: { turn, message: { content: [{ type: 'text', text: answer }] } },
    });
  }
  if (end) events.push({ seq: 4, type: 'turn/end', data: { turn, reason: { kind: end } } });
  return events;
}

test('a completed turn yields its answer', async () => {
  const { session } = sessionOf([turnEvents()]);
  const state = await recoverAssistantTextByPromptRpcId({ session, promptRpcId: 'im-1' });
  assert.equal(state.status, 'ready');
  assert.equal(state.text, 'ответ');
  assert.equal(state.turn, 1);
});

test('a turn still running is pending, not missing', async () => {
  const { session } = sessionOf([turnEvents({ end: null })]);
  const state = await recoverAssistantTextByPromptRpcId({ session, promptRpcId: 'im-1' });
  assert.equal(state.status, 'pending');
});

test('a turn that ended without an answer is missing', async () => {
  const { session } = sessionOf([turnEvents({ withAnswer: false })]);
  assert.equal((await recoverAssistantTextByPromptRpcId({ session, promptRpcId: 'im-1' })).status, 'missing');

  const interrupted = sessionOf([turnEvents({ end: 'cancelled' })]);
  assert.equal(
    (await recoverAssistantTextByPromptRpcId({ session: interrupted.session, promptRpcId: 'im-1' })).status,
    'missing',
  );
});

test('another prompt id never matches', async () => {
  const { session } = sessionOf([turnEvents({ rpcId: 'im-2' })]);
  assert.equal((await recoverAssistantTextByPromptRpcId({ session, promptRpcId: 'im-1' })).status, 'missing');
});

test('an older prompt is found by paging back', async () => {
  const firstPage = [
    { seq: 10, type: 'turn/start', data: { turn: 2 } },
    { seq: 11, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ];
  const secondPage = [
    { seq: 1, type: 'user/message', data: { turn: 1, source: { kind: 'user', rpcId: 'im-1' } } },
    { seq: 2, type: 'turn/start', data: { turn: 1 } },
    { seq: 3, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'старый ответ' }] } } },
    { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const { session, calls } = sessionOf([firstPage, secondPage]);
  const state = await recoverAssistantTextByPromptRpcId({ session, promptRpcId: 'im-1' });
  assert.equal(state.status, 'ready');
  assert.equal(state.text, 'старый ответ');
  assert.equal(calls.length, 2, 'the first page held no prompt, so the read paged back');
});

test('an interrupted assistant message is never offered as the answer', async () => {
  const events = turnEvents();
  events[2].data.interrupted = true;
  const { session } = sessionOf([events]);
  assert.equal((await recoverAssistantTextByPromptRpcId({ session, promptRpcId: 'im-1' })).status, 'missing');
});
