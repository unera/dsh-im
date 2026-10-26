/**
 * Decode a stored conversation key back into the parts a caller can reason
 * about: whether it is a direct chat, a group, or a thread, plus the ids
 * inside it.
 *
 * The keys are written by the channel codecs in `./route.mjs` (and by the
 * channels that still own their own key shape), so this reader accepts every
 * shape we know about. It never invents a key: an unknown or malformed string
 * yields `null` and the caller treats the conversation as unidentified.
 *
 * Known shapes:
 *   direct:dm:<senderId>            Matrix direct chat
 *   direct:<senderId>               Telegram / generic direct chat
 *   group:<chatId>                  group without a thread
 *   group:<chatId>:thread:<threadId> Feishu thread (older shape)
 *   group:<chatId>:<threadId>       Telegram forum topic
 *   group:room:<roomId>[$<root>]    Matrix room, `$` separates a thread root
 */

/**
 * @typedef {Object} ParsedConversationKey
 * @property {'dm'|'group'|'thread'} chatType
 * @property {?string} chatId
 * @property {?string} threadId
 * @property {?string} senderId
 */

const SEP = ':';

/** Everything before the first separator is the scope. */
function scopeOf(key) {
  const index = key.indexOf(SEP);
  return index === -1 ? key : key.slice(0, index);
}

function restOf(key) {
  const index = key.indexOf(SEP);
  return index === -1 ? '' : key.slice(index + 1);
}

function parseDirect(rest) {
  const parts = rest.split(SEP);
  // `direct:dm:<id>` — Matrix keeps an explicit `dm` marker.
  const id = parts[0] === 'dm' ? parts[1] : parts[0];
  if (!id) return null;
  return { chatType: 'dm', chatId: null, threadId: null, senderId: id };
}

function parseMatrixRoom(rest) {
  const body = rest.slice('room:'.length);
  const mark = body.indexOf('$');
  if (mark === -1) {
    return body ? { chatType: 'group', chatId: body, threadId: null, senderId: null } : null;
  }
  const chatId = body.slice(0, mark);
  const threadId = body.slice(mark + 1);
  if (!chatId) return null;
  return { chatType: 'thread', chatId, threadId: threadId || null, senderId: null };
}

function parseGroup(rest) {
  // Matrix rooms keep their own prefix; everything else is `<chatId>[:<thread>]`
  // or the explicit `<chatId>:thread:<threadId>` form.
  if (rest.startsWith('room:')) return parseMatrixRoom(rest);
  const parts = rest.split(SEP);
  const chatId = parts[0];
  if (!chatId) return null;
  if (parts.length === 1) return { chatType: 'group', chatId, threadId: null, senderId: null };
  if (parts[1] === 'thread') {
    const threadId = parts.slice(2).join(SEP);
    return { chatType: 'thread', chatId, threadId: threadId || null, senderId: null };
  }
  const threadId = parts.slice(1).join(SEP);
  return { chatType: 'thread', chatId, threadId: threadId || null, senderId: null };
}

/**
 * Decode one conversation key.
 * @param {unknown} key stored conversation key
 * @returns {?ParsedConversationKey} parts, or null when the key is not ours
 */
export function parseConversationKey(key) {
  if (typeof key !== 'string' || key === '' || key.length > 1_024) return null;
  const scope = scopeOf(key);
  const rest = restOf(key);
  if (rest === '') return null;
  if (scope === 'direct') return parseDirect(rest);
  if (scope === 'group') return parseGroup(rest);
  return null;
}
