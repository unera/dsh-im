function assistantText(event) {
  if (event?.type !== 'assistant/message'
    || !Number.isSafeInteger(event.data?.turn)
    || event.data.turn < 0
    || !Array.isArray(event.data?.message?.content)) return null;
  const text = event.data.message.content
    .flatMap((block) => (block?.type === 'text' && typeof block.text === 'string'
      ? [block.text]
      : []))
    .join('\n')
    .trim();
  return text ? { turn: event.data.turn, time: event.time, text } : null;
}

function completedAssistantTurns(events) {
  const starts = new Map();
  const assistants = new Map();
  const completed = [];
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event?.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) {
      starts.set(event.data.turn, event.time);
    }
    const assistant = assistantText(event);
    if (assistant) assistants.set(assistant.turn, assistant);
    if (event?.type !== 'turn/end' || !Number.isSafeInteger(event.data?.turn)) continue;
    const final = assistants.get(event.data.turn);
    assistants.delete(event.data.turn);
    if ((event.data?.reason?.kind ?? event.data?.reason) !== 'completed' || !final) continue;
    completed.push({
      ...final,
      startedAt: starts.get(event.data.turn),
      completedAt: event.time,
    });
  }
  return completed;
}

function matchingAssistantText(events, quotedAt, toleranceMs) {
  const candidates = completedAssistantTurns(events).filter((entry) => {
    if (Number.isFinite(entry.time) && Math.abs(entry.time - quotedAt) <= toleranceMs) {
      return true;
    }
    return Number.isFinite(entry.startedAt) && Number.isFinite(entry.completedAt)
      && quotedAt >= entry.startedAt - toleranceMs
      && quotedAt <= entry.completedAt + toleranceMs;
  });
  return candidates.length === 1 ? candidates[0].text : null;
}

/**
 * Recover one completed assistant answer near a provider message timestamp.
 *
 * @param {object} options Recovery inputs.
 * @param {{readHistory: Function}} options.session Bound Harness Session handle.
 * @param {number} options.quotedAt Provider message timestamp in milliseconds.
 * @param {AbortSignal} [options.signal] Caller cancellation signal.
 * @param {number} [options.pageSize=100] History events requested per page.
 * @param {number} [options.maxPages=3] Maximum history pages to inspect.
 * @param {number} [options.timeoutMs=5000] Total history read deadline.
 * @param {number} [options.toleranceMs=15000] Provider/session clock tolerance.
 * @returns {Promise<string|null>} The unique matching answer, or null.
 */
export async function recoverAssistantTextByTimestamp({
  session,
  quotedAt,
  signal: callerSignal,
  pageSize = 100,
  maxPages = 3,
  timeoutMs = 5_000,
  toleranceMs = 15_000,
} = {}) {
  if (typeof session?.readHistory !== 'function' || !Number.isFinite(quotedAt)) return null;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  const deadline = Date.now() + timeoutMs;
  const events = new Map();
  let beforeSeq;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    signal.throwIfAborted();
    const page = await session.readHistory({
      maxMessages: pageSize,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      timeoutMs: Math.max(1, deadline - Date.now()),
      signal,
    });
    if (!page || !Array.isArray(page.events) || typeof page.hasMore !== 'boolean') return null;
    let oldestSeq = beforeSeq ?? Infinity;
    let oldestTime = Infinity;
    for (const entry of page.events) {
      const event = entry?.event;
      if (!event || !Number.isSafeInteger(event.seq) || event.seq < 0) continue;
      events.set(event.seq, event);
      oldestSeq = Math.min(oldestSeq, event.seq);
      if (Number.isFinite(event.time)) oldestTime = Math.min(oldestTime, event.time);
    }
    const text = matchingAssistantText([...events.values()], quotedAt, toleranceMs);
    const passedTarget = oldestTime <= quotedAt - toleranceMs;
    if (text && (passedTarget || !page.hasMore)) return text;
    if (!page.hasMore || passedTarget
      || !Number.isFinite(oldestSeq) || oldestSeq === beforeSeq) break;
    beforeSeq = oldestSeq;
  }
  return null;
}

/**
 * Where the turn opened by one prompt id stands, read from the Session ledger.
 *
 * `pending` means the turn has not ended yet, which is the normal answer to a
 * button pressed mid-turn: the reply does not exist, and pressing again later
 * is the intended way to get it.
 */
function promptTurnState(events, promptRpcId) {
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  const submitted = ordered.find((event) => event?.type === 'user/message'
    && event.data?.source?.rpcId === promptRpcId);
  // `absent` means the prompt is not in this window: page further back.
  if (!submitted) return { status: 'absent' };
  const start = ordered.find((event) => event.seq > submitted.seq
    && event.type === 'turn/start'
    && Number.isSafeInteger(event.data?.turn));
  if (!start) return { status: 'pending' };
  const turn = start.data.turn;
  const end = ordered.find((event) => event.seq > start.seq
    && event.type === 'turn/end'
    && event.data?.turn === turn);
  if (!end) return { status: 'pending' };
  const final = ordered.filter((event) => event.seq > start.seq
    && event.seq < end.seq
    && event.type === 'assistant/message'
    && event.data?.turn === turn
    && event.data?.interrupted !== true)
    .at(-1);
  const assistant = assistantText(final);
  const reason = end.data?.reason?.kind ?? end.data?.reason;
  if (!assistant || reason !== 'completed') return { status: 'missing' };
  return { status: 'ready', turn, text: assistant.text };
}

/**
 * Recover the answer of the turn opened by one prompt id.
 *
 * The id is the durable `promptRpcId` of the `user/message` that started the
 * turn, so this needs no timestamp guesswork and no in-memory bookkeeping: a
 * retry button can carry it and still work after a restart.
 *
 * @param {object} options Recovery inputs.
 * @param {{readHistory: Function}} options.session Bound Harness Session handle.
 * @param {string} options.promptRpcId The id the prompt was submitted under.
 * @param {AbortSignal} [options.signal] Caller cancellation signal.
 * @param {number} [options.pageSize=100] History events requested per page.
 * @param {number} [options.maxPages=3] Maximum history pages to inspect.
 * @param {number} [options.timeoutMs=5000] Total history read deadline.
 * @returns {Promise<{status: 'ready'|'pending'|'missing', turn?: number, text?: string}>}
 */
export async function recoverAssistantTextByPromptRpcId({
  session,
  promptRpcId,
  signal: callerSignal,
  pageSize = 100,
  maxPages = 3,
  timeoutMs = 5_000,
} = {}) {
  if (typeof session?.readHistory !== 'function'
    || typeof promptRpcId !== 'string' || !promptRpcId) return { status: 'missing' };
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  const deadline = Date.now() + timeoutMs;
  const events = new Map();
  let beforeSeq;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    signal.throwIfAborted();
    const page = await session.readHistory({
      maxMessages: pageSize,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      timeoutMs: Math.max(1, deadline - Date.now()),
      signal,
    });
    if (!page || !Array.isArray(page.events) || typeof page.hasMore !== 'boolean') {
      return { status: 'missing' };
    }
    let oldestSeq = beforeSeq ?? Infinity;
    for (const entry of page.events) {
      const event = entry?.event;
      if (!event || !Number.isSafeInteger(event.seq) || event.seq < 0) continue;
      events.set(event.seq, event);
      oldestSeq = Math.min(oldestSeq, event.seq);
    }
    const state = promptTurnState([...events.values()], promptRpcId);
    if (state.status !== 'absent') return state;
    if (!page.hasMore || !Number.isFinite(oldestSeq) || oldestSeq === beforeSeq) {
      return { status: 'missing' };
    }
    beforeSeq = oldestSeq;
  }
  return { status: 'missing' };
}
