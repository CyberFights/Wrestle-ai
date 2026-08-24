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
 * On its own, <base> is also the name of the OLD single-folder layout (one
 * folder per user holding chats and facts together in a single file) — the
 * app splits those into the two typed folders above on startup.
 *
 * The mapping is deterministic and injective, so the same user always resolves
 * to the same folders and two different users can never share one.
 */

const crypto = require('crypto');

const FOLDER_PREFIX = 'memory';
const CHAT_FOLDER_SUFFIX = '_chats';
const FACTS_FOLDER_SUFFIX = '_facts';

// MongoDB collection names max out at 120 bytes; the base name must stay
// short enough that both typed folder names (base + suffix) still fit.
const MAX_BASE_BYTES = 120 - Math.max(CHAT_FOLDER_SUFFIX.length, FACTS_FOLDER_SUFFIX.length);

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

// The user's chat messages folder:  <base>_chats
function chatFolderNameForUser(userId) {
  return collectionNameForUser(userId) + CHAT_FOLDER_SUFFIX;
}

// The user's character facts folder:  <base>_facts
function factsFolderNameForUser(userId) {
  return collectionNameForUser(userId) + FACTS_FOLDER_SUFFIX;
}

// True when `name` looks like one of our per-user memory folders — either a
// typed ..._chats / ..._facts folder or an old untyped single folder.
function isUserFolderName(name) {
  return typeof name === 'string' && /^memory_[rbh]_/.test(name);
}

// True for chat folders (<base>_chats). Note that an old untyped folder for a
// user id that happens to end in "_chats" matches this too — that ambiguity is
// resolved by looking at the document inside (see memoryStore.migrateLegacyMemory).
function isChatFolderName(name) {
  return isUserFolderName(name) && name.endsWith(CHAT_FOLDER_SUFFIX);
}

// True for character facts folders (<base>_facts) — same caveat as above.
function isFactsFolderName(name) {
  return isUserFolderName(name) && name.endsWith(FACTS_FOLDER_SUFFIX);
}

module.exports = {
  FOLDER_PREFIX,
  CHAT_FOLDER_SUFFIX,
  FACTS_FOLDER_SUFFIX,
  collectionNameForUser,
  chatFolderNameForUser,
  factsFolderNameForUser,
  isUserFolderName,
  isChatFolderName,
  isFactsFolderName
};
