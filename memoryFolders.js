'use strict';

/*
 * memoryFolders.js — maps a user id to its own MongoDB collections ("folders").
 *
 * MongoDB has no concept of folders, so the closest structure is a set of
 * collections per user, kept under a shared "memory_" prefix inside the
 * memory database. Each user gets TWO folders — one for chat messages and
 * one for character facts:
 *
 *   <base>_chats   the chat messages folder
 *   <base>_facts   the character facts folder
 *
 * where <base> is derived from the user id:
 *
 *   memory_r_<user_id>      readable ids (letters, digits, `-` and `_`)
 *   memory_b_<base64url>    any other id, URL-safe base64 encoded
 *   memory_h_<sha256>       ids whose encoded name would exceed Mongo's limit
 *
 * Chats and facts are kept PER ENDPOINT so the battle bot and the casual
 * chat bot never share conversation context (that shared history used to make
 * /wrestling_chat answer like the wrestling battle persona):
 *
 *   <base>_chats            chat messages sent through /wrestling_chat
 *   <base>_chats_battle     chat messages sent through /wrestling_bot
 *   <base>_facts            character facts learned through /wrestling_chat
 *   <base>_facts_battle     character facts learned through /wrestling_bot
 *
 * The un-suffixed ("chat") folders keep their original names so existing
 * chat-scoped data is preserved as-is. The battle folders append `_battle`.
 *
 * On its own, <base> is also the name of the OLD single-folder layout (one
 * folder per user holding chats and facts together in a single file) — the
 * app splits those into the battle-scoped folders on startup (the wrestling
 * battle bot is the original product, so its legacy history belongs there).
 *
 * The mapping is deterministic and injective, so the same user always resolves
 * to the same folders and two different users can never share one.
 */

const crypto = require('crypto');

const FOLDER_PREFIX = 'memory';
const CHAT_FOLDER_SUFFIX = '_chats';
const FACTS_FOLDER_SUFFIX = '_facts';

// The two endpoint scopes. 'chat' folders keep the original names (no extra
// suffix); 'battle' folders append BATTLE_SCOPE_SUFFIX.
const CHAT_SCOPE = 'chat';
const BATTLE_SCOPE = 'battle';
const BATTLE_SCOPE_SUFFIX = '_battle';

// MongoDB collection names max out at 120 bytes; the base name must stay
// short enough that the longest typed folder name (base + "_chats_battle" or
// "_facts_battle") still fits.
const LONGEST_SCOPE_SUFFIX = CHAT_FOLDER_SUFFIX + BATTLE_SCOPE_SUFFIX; // '_chats_battle'
const MAX_BASE_BYTES = 120 - LONGEST_SCOPE_SUFFIX.length;

function collectionNameForUser(userId) {
  const id = String(userId);

  // Keep short, already-safe ids readable for easy debugging.
  if (/^[A-Za-z0-9_-]{1,60}$/.test(id)) {
    return `${FOLDER_PREFIX}_r_${id}`;
  }

  const encoded = Buffer.from(id, 'utf8').toString('base64url');
  const candidate = `${FOLDER_PREFIX}_b_${encoded}`;

  if (Buffer.byteLength(candidate, 'utf8') <= MAX_BASE_BYTES) {
    return candidate;
  }

  const hash = crypto.createHash('sha256').update(id).digest('hex');
  return `${FOLDER_PREFIX}_h_${hash}`;
}

// Only the battle scope adds a suffix; the chat scope keeps the original names
// so pre-existing chat folders remain valid.
function scopeSuffix(scope) {
  return scope === BATTLE_SCOPE ? BATTLE_SCOPE_SUFFIX : '';
}

// The user's chat messages folder:  <base>_chats[_battle]
function chatFolderNameForUser(userId, scope = CHAT_SCOPE) {
  return collectionNameForUser(userId) + CHAT_FOLDER_SUFFIX + scopeSuffix(scope);
}

// The user's character facts folder:  <base>_facts[_battle]
function factsFolderNameForUser(userId, scope = CHAT_SCOPE) {
  return collectionNameForUser(userId) + FACTS_FOLDER_SUFFIX + scopeSuffix(scope);
}

// True when `name` looks like one of our per-user memory folders — either a
// typed ..._chats / ..._facts folder (of either scope) or an old untyped
// single folder.
function isUserFolderName(name) {
  return typeof name === 'string' && /^memory_[rbh]_/.test(name);
}

// True for chat folders of either scope (<base>_chats or <base>_chats_battle).
// Note that an old untyped folder for a user id that happens to end in "_chats"
// matches this too — that ambiguity is resolved by looking at the document
// inside (see memoryStore.migrateLegacyMemory).
function isChatFolderName(name) {
  return isUserFolderName(name) &&
    (name.endsWith(CHAT_FOLDER_SUFFIX) || name.endsWith(CHAT_FOLDER_SUFFIX + BATTLE_SCOPE_SUFFIX));
}

// True for character facts folders of either scope (<base>_facts or
// <base>_facts_battle) — same caveat as above.
function isFactsFolderName(name) {
  return isUserFolderName(name) &&
    (name.endsWith(FACTS_FOLDER_SUFFIX) || name.endsWith(FACTS_FOLDER_SUFFIX + BATTLE_SCOPE_SUFFIX));
}

module.exports = {
  FOLDER_PREFIX,
  CHAT_FOLDER_SUFFIX,
  FACTS_FOLDER_SUFFIX,
  CHAT_SCOPE,
  BATTLE_SCOPE,
  BATTLE_SCOPE_SUFFIX,
  scopeSuffix,
  collectionNameForUser,
  chatFolderNameForUser,
  factsFolderNameForUser,
  isUserFolderName,
  isChatFolderName,
  isFactsFolderName
};
