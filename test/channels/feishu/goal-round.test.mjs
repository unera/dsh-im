import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuHarnessBridge } from '../../../src/channels/feishu/bridge.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => { for (let i = 0; i < 8; i++) await tick(); };

const KEY = 'group:chat-1:thread:thread-1';
const SESSION = 'session';

const goal = (round = 1, turn = 4, seq = 100 + turn) => ({
  type: 'user/message',
  seq,
  surfaceOp: 'append',
  data: {
    turn,
    source: { kind: 'goal', goalId: 'goal-1', revision: 1, round },
    content: [{
      type: 'text',
      text: `<goal_round>\nObjective: "keep building the service"\nRound: ${round}/256\n\nContinue working toward the objective.`,
    }],
  },
});
const tool = (turn = 4, seq = 102) => ({
  type: 'tool/call', seq, data: { turn, name: 'bash', arguments: '{"command":"ls"}' },
});
const answer = (text, turn = 4, seq = 103) => ({
  type: 'assistant/message',
  seq,
  surfaceOp: 'append',
  data: { turn, step: 1, message: { content: [{ type: 'text', text }] } },
});
const end = (turn = 4, seq = 104, kind = 'completed') => ({
  type: 'turn/end', seq, data: { turn, reason: { kind } },
});

async function fixture(t, { resolver = async () => [], withRoute = true } = {}) {
  let listener;
  const controller = new AbortController();
  const creates = [];
  const replies = [];
  const patches = [];
  const visible = new Map();
  const state = {
    sessionFor: key => (key === KEY ? SESSION : undefined),
    hasSeen: () => false,
    markSeen: async () => {},
    keysWatching: () => [],
    watchEntry: () => undefined,
    setMirror: async () => {},
    clearMirror: async () => {},
    mirrorEntries: () => [],
  };
  const harness = {
    watchHarnessEvents: ({ onSessionEvent, signal }) => {
      listener = onSessionEvent;
      return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    },
    rpc: async () => ({ events: [], hasMore: false }),
    ensureRunning: async () => true,
    sessionExists: async () => true,
  };
  const bridge = new FeishuHarnessBridge({
    botId: 'bot-a',
    harness,
    state,
    status: {},
    channel: {},
    signal: controller.signal,
    allowedSenderOpenIds: new Set(['ou_owner']),
    logger: { warn() {}, debug() {}, error() {} },
    sessionSyncTargetsFor: resolver,
    stepPushClock: { now: () => Date.now(), delay: async () => {} },
    client: {
      im: {
        v1: {
          message: {
            create: async request => {
              creates.push(structuredClone(request));
              const id = `card-${creates.length}`;
              visible.set(id, request.data.content);
              return { code: 0, data: { message_id: id } };
            },
            patch: async request => {
              patches.push(structuredClone(request));
              visible.set(request.path.message_id, request.data.content);
              return { code: 0 };
            },
            reply: async request => {
              replies.push(structuredClone(request));
              const id = `reply-${replies.length}`;
              visible.set(id, request.data.content);
              return { code: 0, data: { message_id: id } };
            },
          },
        },
      },
    },
  });
  t.after(() => controller.abort());
  await flush();
  if (withRoute) {
    bridge.rememberConversationRoute(KEY, { chatId: 'chat-1', replyToMessageId: 'om-topic-1' });
  }
  const emit = event => listener({ sessionId: SESSION, event });
  const drain = async () => {
    await bridge.waitForIdle();
    await flush();
  };
  const lastCard = () => [...visible.values()].at(-1) ?? '';
  return { bridge, emit, drain, creates, replies, patches, visible, lastCard };
}

test('a goal round opened outside the IM shows its progress and result in the bound conversation', async t => {
  const f = await fixture(t);

  f.emit(goal(1));
  await f.drain();

  assert.equal(f.replies.length, 1, 'the round opens a card in the conversation');
  const opening = f.replies[0];
  assert.equal(opening.path.message_id, 'om-topic-1', 'the card replies to the conversation anchor');
  assert.match(opening.data.content, /目标自动续跑（第 1 轮）/);
  assert.doesNotMatch(opening.data.content, /goal_round/);
  assert.doesNotMatch(opening.data.content, /Objective:/);

  f.emit(tool());
  await f.drain();
  f.emit(answer('本轮完成：PvE 战斗改为逐回合结算。'));
  await f.drain();
  f.emit(end());
  await f.drain();

  const card = f.lastCard();
  assert.match(card, /bash/);
  assert.match(card, /目标自动续跑（第 1 轮）/);
  assert.match(card, /PvE 战斗改为逐回合结算/);
  assert.match(card, /已完成/);
  assert.doesNotMatch(card, /goal_round/);
});

test('each continuation round starts a new card and delivers its own result', async t => {
  const f = await fixture(t);

  f.emit(goal(1, 4));
  await f.drain();
  f.emit(answer('第一轮结果', 4));
  await f.drain();
  f.emit(end(4));
  await f.drain();

  f.emit(goal(2, 5, 205));
  await f.drain();
  f.emit(answer('第二轮结果', 5));
  await f.drain();
  f.emit(end(5, 208));
  await f.drain();

  assert.equal(f.replies.length, 2);
  assert.match(f.replies[0].data.content, /第 1 轮/);
  assert.match(f.replies[1].data.content, /第 2 轮/);
  assert.match(f.lastCard(), /第二轮结果/);
});

test('a synced DM owns the round: no second card is rendered into the conversation', async t => {
  const f = await fixture(t, {
    resolver: async () => [{ channel: 'feishu', botId: 'bot-a', openId: 'ou_owner', targetId: 'owner' }],
  });

  f.emit(goal(1));
  await f.drain();

  assert.equal(f.replies.length, 0, 'the goal path must not answer over the mirror');
  assert.equal(f.creates.length, 1, 'only the mirror card exists');
  assert.equal(f.creates[0].params?.receive_id_type, 'open_id', 'the mirror card goes to the synced DM');
  const mirrored = f.creates[0].data.content;
  assert.match(mirrored, /目标自动续跑（第 1 轮）/);
  assert.doesNotMatch(mirrored, /goal_round/);
});
