// Applying a bot's persona to a freshly created Session.
//
// Why this lives inside dsh-im and not in an external plugin: `agent/created`
// fires before dsh-im writes `sessions[conversationKey] = sessionId` into
// `bots/<botId>/state.json`, so an outside observer cannot learn which chat a
// brand-new Session belongs to in time. The first prompt is assembled inside
// `ask`, and by then the Session is already created — so the binding must be
// written here, between `createSession` and `ask`, while `botId` and
// `conversationKey` are known.
//
// Two independent settings travel together:
//   profile    — an agent-profile id owned by the `dsh-agent-profiles` plugin,
//                which exposes no service and only HTTP commands;
//   permission — a Host permission preset, switched through the Host's own
//                `/permission` command (the same path the `/permission` chat
//                command uses), so no private API is involved.
//
// Both are best-effort by design: a deleted profile or an unreachable endpoint
// must never block a reply, so every failure is logged once and swallowed.

const DEFAULT_PORT = 3080;
const DEFAULT_TIMEOUT_MS = 2000;
const PROFILE_ID = /^[\w.:-]{1,128}$/u;
const PERMISSION_ID = /^[^\s\p{Cc}\p{Cf}]{1,64}$/u;

/** Is this a plausible agent-profile id? Bare ids only, never a pattern. */
export function validProfileId(value) {
  return typeof value === 'string' && PROFILE_ID.test(value);
}

/** Is this a plausible permission preset name? */
export function validPermissionId(value) {
  return typeof value === 'string' && PERMISSION_ID.test(value);
}

/**
 * The agent-profiles command endpoint. dsh-im runs inside the Host process, so
 * loopback is the honest default; an installation that serves the Web GUI
 * elsewhere overrides it with `DSH_PROFILES_ENDPOINT`.
 */
export function resolveProfilesEndpoint(env = process.env) {
  const explicit = typeof env?.DSH_PROFILES_ENDPOINT === 'string'
    ? env.DSH_PROFILES_ENDPOINT.trim() : '';
  if (explicit) return explicit.replace(/\/+$/u, '');
  const rawPort = env?.DSH_WEB_PORT ?? env?.DSH_PORT ?? env?.PORT;
  const port = Number.parseInt(String(rawPort ?? ''), 10);
  return `http://127.0.0.1:${Number.isSafeInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT}`;
}

function reason(error) {
  const text = error?.cause?.message ?? error?.message ?? String(error);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

async function bindProfile({ sessionId, profile, endpoint, fetchImpl, timeoutMs, signal }) {
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(`${endpoint}/__ap/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'session.set', sessionId, patch: { profileId: profile } }),
    signal: requestSignal,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (payload && payload.ok === false) {
    return { ok: false, reason: typeof payload.error === 'string' ? payload.error : 'rejected' };
  }
  if (!response.ok) return { ok: false, reason: `http ${response.status}` };
  return { ok: true };
}

async function switchPermission({ sessionId, permission, executeCommand, signal, timeoutMs }) {
  if (typeof executeCommand !== 'function') {
    return { ok: false, reason: 'commands-unavailable' };
  }
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const execution = await executeCommand(sessionId, `/permission ${permission}`, { signal: requestSignal });
  const outcome = execution?.result;
  if (outcome === undefined) return { ok: false, reason: 'permission-command-missing' };
  if (outcome?.kind === 'error') {
    return { ok: false, reason: typeof outcome.text === 'string' ? outcome.text : 'rejected' };
  }
  return { ok: true };
}

/**
 * Apply `profile` and `permission` to a Session that was just created.
 *
 * Returns per-setting outcomes (`applied` / `skipped` / `failed`) so tests and
 * diagnostics can assert what happened without parsing the log.
 *
 * @param {object} options
 * @param {string} options.sessionId created Session id
 * @param {?string} [options.profile] agent-profile id, or null-ish to skip
 * @param {?string} [options.permission] permission preset name, or null-ish
 * @param {?Function} [options.executeCommand] Host command executor for `/permission`
 * @param {?Function} [options.fetchImpl] fetch implementation (tests)
 * @param {?string} [options.endpoint] agent-profiles endpoint override
 * @param {?object} [options.log] logger with `warn`
 * @param {?AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs] per-request timeout
 */
export async function applySessionPersona({
  sessionId,
  profile,
  permission,
  executeCommand,
  fetchImpl = fetch,
  endpoint = resolveProfilesEndpoint(),
  log = console,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const result = { profile: 'skipped', permission: 'skipped' };
  if (typeof sessionId !== 'string' || !sessionId) return result;

  if (profile !== null && profile !== undefined && profile !== '') {
    if (!validProfileId(profile)) {
      result.profile = 'invalid';
      log?.warn?.(`[dsh-im] profile ${String(profile)} not applied: not a profile id`);
    } else {
      try {
        const bound = await bindProfile({ sessionId, profile, endpoint, fetchImpl, timeoutMs, signal });
        result.profile = bound.ok ? 'applied' : 'failed';
        if (!bound.ok) log?.warn?.(`[dsh-im] profile ${profile} not applied: ${bound.reason}`);
      } catch (error) {
        result.profile = 'failed';
        log?.warn?.(`[dsh-im] profile ${profile} not applied: ${reason(error)}`);
      }
    }
  }

  if (permission !== null && permission !== undefined && permission !== '') {
    if (!validPermissionId(permission)) {
      result.permission = 'invalid';
      log?.warn?.(`[dsh-im] permission ${String(permission)} not applied: not a preset name`);
    } else {
      try {
        const switched = await switchPermission({ sessionId, permission, executeCommand, signal, timeoutMs });
        result.permission = switched.ok ? 'applied' : 'failed';
        if (!switched.ok) {
          log?.warn?.(`[dsh-im] permission ${permission} not applied: ${switched.reason}`);
        }
      } catch (error) {
        result.permission = 'failed';
        log?.warn?.(`[dsh-im] permission ${permission} not applied: ${reason(error)}`);
      }
    }
  }

  return result;
}
