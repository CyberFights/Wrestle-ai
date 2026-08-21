'use strict';

/*
 * memoryFolders.js — maps a user id to its own MongoDB collection ("folder").
 *
 * MongoDB has no concept of folders, so the closest structure is one collection
 * per user, kept under a shared "memory_" prefix inside the memory database:
 *
 *   memory_r_<user_id>      readable ids (letters, digits, `-` and `_`)
 *   memory_b_<base64url>    any other id, URL-safe base64 encoded
 *   memory_h_<sha256>       ids whose encoded name would exceed Mongo's limit
 *
 * The mapping is deterministic and injective, so the same user always resolves
 * to the same folder and two different users can never share one.
 */

const crypto = require('crypto');

const FOLDER_PREFIX = 'memory';

function collectionNameForUser(userId) {
  const id = String(userId);

  // Keep short, already-safe ids readable for easy debugging.
  if (/^[A-Za-z0-9_-]{1,60}$/.test(id)) {
    return `${FOLDER_PREFIX}_r_${id}`;
  }

  const encoded = Buffer.from(id, 'utf8').toString('base64url');
  const candidate = `${FOLDER_PREFIX}_b_${encoded}`;

  // MongoDB collection names max out at 120 bytes.
  if (Buffer.byteLength(candidate, 'utf8') <= 120) {
    return candidate;
  }

  const hash = crypto.createHash('sha256').update(id).digest('hex');
  return `${FOLDER_PREFIX}_h_${hash}`;
}

// True when `name` looks like one of our per-user memory folders.
function isUserFolderName(name) {
  return typeof name === 'string' && /^memory_[rbh]_/.test(name);
}

module.exports = {
  FOLDER_PREFIX,
  collectionNameForUser,
  isUserFolderName
};
