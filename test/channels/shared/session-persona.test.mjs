import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applySessionPersona,
  resolveProfilesEndpoint,
  validPermissionId,
  validProfileId,
} from '../../../src/channels/shared/session-persona.mjs';

function quietLogger() {
  const lines = [];
  return { lines, warn: (...args) => lines.push(args.join(' ')) };
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

describe('profile and permission ids', () => {
  it('accepts bare profile ids and rejects patterns or whitespace', () => {
    assert.equal(validProfileId('p-137551a917'), true);
    assert.equal(validProfileId('p-137551a917 '), false);
    assert.equal(validProfileId('p-*'), false);
    assert.equal(validProfileId(''), false);
    assert.equal(validProfileId(null), false);
  });

  it('accepts preset names and rejects control characters', () => {
    assert.equal(validPermissionId('workspace-write'), true);
    assert.equal(validPermissionId('read-only'), true);
    assert.equal(validPermissionId('bad name'), false);
    assert.equal(validPermissionId('bad\u0007name'), false);
  });
});

describe('endpoint resolution', () => {
  it('defaults to loopback 3080', () => {
    assert.equal(resolveProfilesEndpoint({}), 'http://127.0.0.1:3080');
  });

  it('follows the host port and an explicit override', () => {
    assert.equal(resolveProfilesEndpoint({ DSH_PORT: '4567' }), 'http://127.0.0.1:4567');
    assert.equal(
      resolveProfilesEndpoint({ DSH_PROFILES_ENDPOINT: 'http://dsh.local:9000/' }),
      'http://dsh.local:9000',
    );
  });
});

describe('applySessionPersona', () => {
  it('binds the profile through the profiles command route', async () => {
    const calls = [];
    const outcomes = await applySessionPersona({
      sessionId: 'session-1',
      profile: 'p-dc002893d6',
      endpoint: 'http://127.0.0.1:3080',
      fetchImpl: async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return jsonResponse({ ok: true });
      },
      log: quietLogger(),
    });
    assert.equal(outcomes.profile, 'applied');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:3080/__ap/command');
    assert.deepEqual(calls[0].body, {
      op: 'session.set',
      sessionId: 'session-1',
      patch: { profileId: 'p-dc002893d6' },
    });
  });

  it('switches the permission preset through the host command', async () => {
    const lines = [];
    const outcomes = await applySessionPersona({
      sessionId: 'session-1',
      permission: 'workspace-write',
      executeCommand: async (sessionId, line) => {
        lines.push([sessionId, line]);
        return { result: { kind: 'success', text: 'ok' } };
      },
      log: quietLogger(),
    });
    assert.equal(outcomes.permission, 'applied');
    assert.deepEqual(lines, [['session-1', '/permission workspace-write']]);
  });

  it('does nothing when neither setting is present', async () => {
    const outcomes = await applySessionPersona({
      sessionId: 'session-1',
      fetchImpl: async () => assert.fail('profiles must not be called'),
      executeCommand: async () => assert.fail('commands must not run'),
      log: quietLogger(),
    });
    assert.deepEqual(outcomes, { profile: 'skipped', permission: 'skipped' });
  });

  it('reports an unreachable profiles endpoint once and never throws', async () => {
    const log = quietLogger();
    const outcomes = await applySessionPersona({
      sessionId: 'session-1',
      profile: 'p-deleted',
      fetchImpl: async () => assert.fail('no network in this test'), // rejected below
      log,
    }).catch((error) => error);
    assert.equal(outcomes.profile, 'failed');
    assert.equal(log.lines.length, 1);
    assert.match(log.lines[0], /profile p-deleted not applied:/);
  });

  it('reports a rejected profile id from the profiles plugin', async () => {
    const log = quietLogger();
    const outcomes = await applySessionPersona({
      sessionId: 'session-1',
      profile: 'p-deleted',
      fetchImpl: async () => jsonResponse({ ok: false, error: '没有这套配置（可能已被删除）。' }),
      log,
    });
    assert.equal(outcomes.profile, 'failed');
    assert.equal(log.lines.length, 1);
    assert.match(log.lines[0], /deleted/);
  });

  it('reports an unknown permission preset without throwing', async () => {
    const log = quietLogger();
    const outcomes = await applySessionPersona({
      sessionId: 'session-1',
      permission: 'nope',
      executeCommand: async () => ({ result: { kind: 'error', text: 'unknown preset "nope"' } }),
      log,
    });
    assert.equal(outcomes.permission, 'failed');
    assert.match(log.lines[0], /permission nope not applied: unknown preset/);
  });

  it('treats a missing command surface as a warning, not a failure to reply', async () => {
    const log = quietLogger();
    const outcomes = await applySessionPersona({
      sessionId: 'session-1',
      permission: 'read-only',
      executeCommand: undefined,
      log,
    });
    assert.equal(outcomes.permission, 'failed');
    assert.match(log.lines[0], /commands-unavailable/);
  });
});
