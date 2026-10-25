import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createBotWorkspaceScope } from '../../../src/channels/shared/bot-workspace-store.mjs';

// The point of this test: the persona must be applied while the Session is
// being created, i.e. before the caller can call `ask`. The fake harness
// records the order of the three observable events, and the assertion is that
// creation ends only after the profile and the permission are in place.
function recordingScope({ persona, applyProfile }) {
  const events = [];
  const harness = {
    async createSession() {
      events.push('createSession');
      return 'session-1';
    },
    async executeCommand(sessionId, line) {
      events.push(`command:${line}`);
      return { result: { kind: 'success', text: 'ok' } };
    },
    async ask() {
      events.push('ask');
      return 'answer';
    },
    async workspaceSession() {
      return { ask: async () => { events.push('ask'); return 'answer'; } };
    },
  };
  const workspaces = {
    has: () => true,
    incarnationFor: () => 1,
    generationFor: () => 1,
    agentPresetFor: () => null,
    modelFor: () => null,
    conversationWorkspaceFor: () => '/tmp/ws',
    whenBotIdle: async () => {},
    dsBotBindingFor: () => null,
    conversationGenerationFor: () => 0,
  };
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    events.push('profile');
    await applyProfile?.();
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const scope = createBotWorkspaceScope(harness, {
    botId: 'telegram_deadbeef',
    workspaces,
    state: { sessionFor: () => null, setSession: async () => true },
    botPersona: persona,
  });
  return {
    events,
    scope,
    restore: () => { globalThis.fetch = previous; },
  };
}

describe('bot scope applies the persona before the first prompt', () => {
  it('binds profile and permission while the session is created', async () => {
    const { events, scope, restore } = recordingScope({
      persona: { profile: 'p-137551a917', permission: 'workspace-write' },
    });
    try {
      const sessionId = await scope.harness.createSession({ conversationKey: 'group:-100:1' });
      assert.equal(sessionId, 'session-1');
      await scope.harness.workspaceSession(sessionId, 'group:-100:1').ask('hi');
    } finally {
      restore();
    }
    assert.deepEqual(events, [
      'createSession',
      'profile',
      'command:/permission workspace-write',
      'ask',
    ]);
  });

  it('does nothing when the bot has no persona configured', async () => {
    const { events, scope, restore } = recordingScope({ persona: null });
    try {
      await scope.harness.createSession({ conversationKey: 'group:-100:1' });
    } finally {
      restore();
    }
    assert.deepEqual(events, ['createSession']);
  });

  it('still creates the session when the profiles endpoint fails', async () => {
    const { events, scope, restore } = recordingScope({
      persona: { profile: 'p-deleted' },
      applyProfile: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:3080'); },
    });
    let sessionId;
    try {
      sessionId = await scope.harness.createSession({ conversationKey: 'group:-100:1' });
    } finally {
      restore();
    }
    assert.equal(sessionId, 'session-1');
    assert.deepEqual(events, ['createSession', 'profile']);
  });
});
