'use strict';

/*
 * memoryStore.js — MongoDB storage layer.
 *
 * The bot keeps its memory inside a MongoDB database (the "memory folder").
 * Each user gets TWO folder PAIRS of their own (their own MongoDB
 * collections) — one pair per endpoint, so the wrestling battle bot and the
 * casual chat bot never share conversation context:
 *
 *   <database>/
 *   ├── memory_r_12345_chats         ← casual chat messages (/wrestling_chat)
 *   ├── memory_r_12345_facts         ← casual chat character facts
 *   ├── memory_r_12345_chats_battle  ← battle messages (/wrestling_bot)
 *   ├── memory_r_12345_facts_battle  ← battle character facts
 *   ├── memory_r_67890_chats
 *   ├── memory_r_67890_facts
 *   └── …
 *
 * Every folder holds ONE "memory file" — a single document keyed by the
 * user id:
 *
 *   <base>_chats → {
 *     _id: "<user_id>", user_id: "<user_id>",
 *     chats: [ { role, message, timestamp } ],   // conversation history
 *     created_at, updated_at
 *   }
 *
 *   <base>_facts → {
 *     _id: "<user_id>", user_id: "<user_id>",
 *     character_facts: "…",      // the memory string fed to the model
 *     matches:    [ { text, timestamp } ],   // matches that came up
 *     key_facts:  [ { text, timestamp } ],   // notable events / facts
 *     created_at, updated_at
 *   }
 *
 * Folders are created automatically the first time anything is stored or read
 * for a user. Only the last 10 chats are ever sent to the model
 * (getLastMessages default), even though the file keeps more.
 *
 * On startup, data still living in older layouts is split into the two
 * folders automatically: the old flat `memory` collection, and the previous
 * single-folder layout (<base> holding chats and facts in one file). The
 * migration is idempotent and never deletes the originals, so restarting and
 * upgrading is always safe.
 *
 * Railway injects MONGO_URL automatically when a MongoDB database is attached
 * to the service.
 */

const { MongoClient } = require('mongodb');
const {
  chatFolderNameForUser,
  factsFolderNameForUser,
  profilesFolderNameForUser,
  personKeyForName,
  isUserFolderName,
  isChatFolderName,
  isFactsFolderName,
  isProfilesFolderName,
  BATTLE_SCOPE
} = require('./memoryFolders');

const MONGO_URL =
  process.env.MONGO_URL ||
  process.env.MONGODB_URI ||
  process.env.MONGO_PUBLIC_URL ||
  process.env.DATABASE_URL;

if (!MONGO_URL) {
  throw new Error('MONGO_URL env variable not set (Railway sets it automatically when a MongoDB database is attached)');
}

const DB_NAME = process.env.MONGO_DB_NAME || dbNameFromUrl(MONGO_URL) || 'wrestling_bot';

// The name of the old, flat collection everything used to live in. It is read
// once at startup (see migrateLegacyMemory) to move its documents into the new
// per-user folders.
const COLLECTION_NAME = process.env.MONGO_MEMORY_COLLECTION || 'memory';

// Railway's MONGO_URL has no database in its path, so a default is used; if a
// database is part of the URL (mongodb://…/mydb) that one wins.
function dbNameFromUrl(url) {
  const withoutScheme = String(url).replace(/^mongodb(\+srv)?:\/\//, '');
  const slash = withoutScheme.indexOf('/');
  if (slash === -1) return null;
  const name = withoutScheme.slice(slash + 1).split('?')[0];
  if (!name) return null;
  try {
    return decodeURIComponent(name);
  } catch (err) {
    return name;
  }
}

// Mongo documents max out at 16 MB, so each memory file keeps only the most
// recent entries. Only the last handful of chats is ever sent to the model.
const CHAT_LIMIT = toPositiveInt(process.env.MEMORY_CHAT_LIMIT, 2000);
const FACT_LIMIT = toPositiveInt(process.env.MEMORY_FACT_LIMIT, 500);

// Only this many most-recent chats are ever sent to the model.
const MODEL_HISTORY_LIMIT = toPositiveInt(process.env.MODEL_HISTORY_LIMIT, 10);

function toPositiveInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const client = new MongoClient(MONGO_URL, {
  maxPoolSize: 10,
  connectTimeoutMS: 10000,
  serverSelectionTimeoutMS: 10000
});

let db = null;

// Folder names whose collection has already been created + indexed this run.
const knownFolders = new Set();

function isNamespaceExistsError(err) {
  return Boolean(err) && (err.code === 48 || err.codeName === 'NamespaceExists');
}

// Returns (creating it on first use) the given folder collection.
async function ensureFolder(name) {
  if (!db) throw new Error('MongoDB is not connected yet — call initDb() first');

  if (!knownFolders.has(name)) {
    const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
    if (!exists) {
      try {
        await db.createCollection(name);
      } catch (err) {
        // Another request may have created it between the check and the create.
        if (!isNamespaceExistsError(err)) throw err;
      }
    }
    await db.collection(name).createIndex({ user_id: 1 });
    knownFolders.add(name);
  }

  return db.collection(name);
}

// The user's chat messages folder for an endpoint scope:  <base>_chats[_battle]
function ensureChatFolder(userId, scope) {
  return ensureFolder(chatFolderNameForUser(userId, scope));
}

// The user's character facts folder for an endpoint scope:  <base>_facts[_battle]
function ensureFactsFolder(userId, scope) {
  return ensureFolder(factsFolderNameForUser(userId, scope));
}

function ensureProfilesFolder(userId) {
  return ensureFolder(profilesFolderNameForUser(userId));
}

async function initDb() {
  await client.connect();
  db = client.db(DB_NAME);

  // Move any data still stored in older layouts (the flat `memory` collection
  // and the combined single folders) into the chats/facts folder pair.
  // Idempotent: files that already exist in the typed folders are left alone.
  const legacy = await migrateLegacyMemory();
  if (legacy.migrated > 0) {
    console.log(
      `Memory folders: ${legacy.migrated} legacy memory file(s) split into separate ` +
      `chats/facts folders (the originals were left untouched).`
    );
  }
  return db;
}

async function closeDb() {
  db = null;
  knownFolders.clear();
  await client.close();
}

// Splits one old-style memory file (chats and/or facts in a single document)
// into the user's BATTLE-scoped chats and facts folders. The wrestling battle
// bot is the original product, so its un-scoped legacy history belongs to the
// battle persona; the casual chat bot starts with a clean slate. A side is
// copied only when the target file does not exist yet, so this is safe to run
// repeatedly and never overwrites anything the app has already written.
async function splitLegacyFile(doc) {
  const userId = doc.user_id != null
    ? String(doc.user_id)
    : (doc._id != null ? String(doc._id) : '');
  if (!userId) return { ok: false, migrated: false };

  const now = new Date();
  let migrated = false;

  const chats = Array.isArray(doc.chats) ? doc.chats : [];
  if (chats.length) {
    const chatFolder = await ensureChatFolder(userId, BATTLE_SCOPE);
    if (!(await chatFolder.findOne({ _id: userId }))) {
      await chatFolder.insertOne({
        _id: userId,
        user_id: userId,
        chats,
        created_at: doc.created_at || now,
        updated_at: doc.updated_at || now
      });
      migrated = true;
    }
  }

  const hasFacts =
    doc.character_facts != null || Array.isArray(doc.matches) || Array.isArray(doc.key_facts);
  if (hasFacts) {
    const factsFolder = await ensureFactsFolder(userId, BATTLE_SCOPE);
    if (!(await factsFolder.findOne({ _id: userId }))) {
      await factsFolder.insertOne({
        _id: userId,
        user_id: userId,
        character_facts: doc.character_facts != null ? String(doc.character_facts) : '',
        matches: Array.isArray(doc.matches) ? doc.matches : [],
        key_facts: Array.isArray(doc.key_facts) ? doc.key_facts : [],
        created_at: doc.created_at || now,
        updated_at: doc.updated_at || now
      });
      migrated = true;
    }
  }

  return { ok: true, migrated };
}

// One-time, idempotent upgrade: split documents out of the legacy layouts —
// the old flat `memory` collection and the old untyped single per-user
// folders — into each user's battle-scoped chats/facts folders. Typed
// ..._chats / ..._facts folders (either scope) are left alone: their files
// already live in the correct scope.
async function migrateLegacyMemory() {
  if (!db) throw new Error('MongoDB is not connected yet — call initDb() first');

  const sources = [];
  let found = false;
  try {
    found = await db.listCollections({ name: COLLECTION_NAME }, { nameOnly: true }).hasNext();
  } catch (err) {
    found = false;
  }
  if (found) sources.push(COLLECTION_NAME);

  const folderCursor = db.listCollections({}, { nameOnly: true });
  while (await folderCursor.hasNext()) {
    const { name } = await folderCursor.next();
    // Only the old untyped single folders are split; typed folders already
    // carry a scope and must not be re-migrated into the battle scope.
    if (
      isUserFolderName(name) &&
      !isChatFolderName(name) &&
      !isFactsFolderName(name) &&
      !isProfilesFolderName(name)
    ) {
      sources.push(name);
    }
  }

  let migrated = 0;
  let skipped = 0;
  for (const name of sources) {
    const cursor = db.collection(name).find({});
    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      const result = await splitLegacyFile(doc);
      if (!result.ok) skipped += 1;
      else if (result.migrated) migrated += 1;
    }
  }

  return { found, migrated, skipped };
}

// Names of every per-user memory folder currently in the database (typed
// ..._chats / ..._facts folders and any old untyped single folders).
async function listUserFolders() {
  if (!db) throw new Error('MongoDB is not connected yet — call initDb() first');
  const folders = [];
  const cursor = db.listCollections({}, { nameOnly: true });
  while (await cursor.hasNext()) {
    const { name } = await cursor.next();
    if (isUserFolderName(name)) folders.push(name);
  }
  return folders.sort();
}

// ---------- CHATS (the user's chats folder) ----------

async function storeMessage(userId, message, role, scope) {
  const id = String(userId);
  const now = new Date();
  const folder = await ensureChatFolder(id, scope);
  await folder.updateOne(
    { _id: id },
    {
      $setOnInsert: {
        user_id: id,
        created_at: now
      },
      $set: { updated_at: now },
      $push: {
        chats: {
          $each: [{ role, message, timestamp: now }],
          $slice: -CHAT_LIMIT
        }
      }
    },
    { upsert: true }
  );
}

// The most recent chats — this is ALL that is ever sent to the model
// (10 by default; see MODEL_HISTORY_LIMIT in memoryStore / wrestling.js).
async function getLastMessages(userId, limit = MODEL_HISTORY_LIMIT, scope) {
  const safeLimit = Math.max(1, Math.min(100, parseInt(limit, 10) || MODEL_HISTORY_LIMIT));
  const id = String(userId);
  const folder = await ensureChatFolder(id, scope);
  const doc = await folder.findOne(
    { _id: id },
    { projection: { chats: { $slice: -safeLimit } } }
  );
  const chats = (doc && doc.chats) || [];
  return chats.map(chat => ({ role: chat.role, content: chat.message }));
}

// ---------- CHARACTER FACTS (the user's facts folder) ----------

// The app builds its memory string by appending segments like
//   " | New match discussed: <message>"  and  " | Notable event: <message>".
// Those segments are split back out here so the facts file also keeps them as
// structured `matches` / `key_facts` lists.
const FACT_MARKER = /\s*\|\s*(New match discussed|Notable event):\s*/g;

function parseFactEntries(text) {
  const matches = [];
  const keyFacts = [];
  if (!text) return { matches, keyFacts };

  const markers = [];
  FACT_MARKER.lastIndex = 0;
  let found;
  while ((found = FACT_MARKER.exec(text)) !== null) {
    markers.push({ type: found[1], start: found.index, end: FACT_MARKER.lastIndex });
  }

  for (let i = 0; i < markers.length; i += 1) {
    const next = markers[i + 1];
    const body = text.slice(markers[i].end, next ? next.start : undefined).trim();
    if (!body) continue;
    if (markers[i].type === 'New match discussed') matches.push(body);
    else keyFacts.push(body);
  }

  return { matches, keyFacts };
}

async function getCharacterFacts(userId, scope) {
  const id = String(userId);
  const folder = await ensureFactsFolder(id, scope);
  const doc = await folder.findOne(
    { _id: id },
    { projection: { character_facts: 1 } }
  );
  return doc && doc.character_facts != null ? doc.character_facts : '';
}

async function updateCharacterFacts(userId, facts, scope) {
  const id = String(userId);
  const now = new Date();
  const nextFacts = facts == null ? '' : String(facts);
  const previousFacts = await getCharacterFacts(id, scope);

  // Only the part that was just appended becomes new matches / key facts.
  const delta = nextFacts.startsWith(previousFacts)
    ? nextFacts.slice(previousFacts.length)
    : nextFacts;
  const { matches, keyFacts } = parseFactEntries(delta);

  const setOnInsert = { user_id: id, created_at: now };
  const push = {};

  if (matches.length) {
    push.matches = {
      $each: matches.map(text => ({ text, timestamp: now })),
      $slice: -FACT_LIMIT
    };
  } else {
    setOnInsert.matches = [];
  }

  if (keyFacts.length) {
    push.key_facts = {
      $each: keyFacts.map(text => ({ text, timestamp: now })),
      $slice: -FACT_LIMIT
    };
  } else {
    setOnInsert.key_facts = [];
  }

  const update = {
    $setOnInsert: setOnInsert,
    $set: { character_facts: nextFacts, updated_at: now }
  };
  if (Object.keys(push).length) update.$push = push;

  const folder = await ensureFactsFolder(id, scope);
  await folder.updateOne({ _id: id }, update, { upsert: true });
}

// ---------- PERSON PROFILES (the user's profiles folder) ----------
// One document per person name, stored under <base>_profiles. Isolated from
// chat/battle/ugcw memory so a profile never leaks into those personas.

const SOURCE_ARCHIVE_CHAR_LIMIT = Number(process.env.PROFILE_SOURCE_ARCHIVE_LIMIT) || 400000;
const REVISION_LIMIT = Number(process.env.PROFILE_REVISION_LIMIT) || 20;

function ensureMemoryIds(memories) {
  return (Array.isArray(memories) ? memories : []).map((mem, index) => {
    if (!mem || typeof mem !== 'object') return mem;
    if (mem.id) return mem;
    return { ...mem, id: `mem_${index}_${Date.now().toString(36)}` };
  });
}

function capSourceArchive(items) {
  const out = [];
  let used = 0;
  for (const item of Array.isArray(items) ? items.slice().reverse() : []) {
    if (!item) continue;
    const text = String(item.text || item.content || '').slice(0, SOURCE_ARCHIVE_CHAR_LIMIT);
    const filename = String(item.filename || item.name || 'source');
    if (!text) continue;
    if (used + text.length > SOURCE_ARCHIVE_CHAR_LIMIT) {
      const room = SOURCE_ARCHIVE_CHAR_LIMIT - used;
      if (room > 200) {
        out.push({ filename, text: text.slice(0, room), stored_at: item.stored_at || new Date() });
      }
      break;
    }
    out.push({ filename, text, stored_at: item.stored_at || new Date() });
    used += text.length;
  }
  return out.reverse();
}

function snapshotRevision(existing) {
  if (!existing) return null;
  return {
    saved_at: existing.updated_at || new Date(),
    profile: existing.profile || {},
    memories: existing.memories || [],
    system_prompt: existing.system_prompt || '',
    sources: existing.sources || []
  };
}

async function savePersonProfile(userId, personName, record) {
  const id = String(userId);
  const name = String(personName || '').trim();
  if (!name) throw new Error('savePersonProfile: personName is required');
  const key = personKeyForName(name);
  const now = new Date();
  const folder = await ensureProfilesFolder(id);
  const existing = await folder.findOne({ _id: key });
  const memories = ensureMemoryIds(
    Array.isArray(record && record.memories)
      ? record.memories
      : (record && record.profile && Array.isArray(record.profile.memories) ? record.profile.memories : [])
  );
  const profile = record && record.profile ? { ...record.profile } : {};
  if (!Array.isArray(profile.memories)) profile.memories = memories;
  const incomingArchive = Array.isArray(record && record.source_archive)
    ? record.source_archive
    : (Array.isArray(record && record.documents) ? record.documents : []);
  const source_archive = capSourceArchive([
    ...((existing && existing.source_archive) || []),
    ...incomingArchive.map(doc => ({
      filename: doc.filename || doc.name,
      text: doc.text || doc.content,
      stored_at: now
    }))
  ]);
  const revisions = Array.isArray(existing && existing.revisions) ? existing.revisions.slice() : [];
  const snap = snapshotRevision(existing);
  if (snap) {
    revisions.push(snap);
    if (revisions.length > REVISION_LIMIT) revisions.splice(0, revisions.length - REVISION_LIMIT);
  }
  const consent = record && Object.prototype.hasOwnProperty.call(record, 'consent')
    ? record.consent
    : (existing && existing.consent);
  const doc = {
    _id: key,
    user_id: id,
    person_key: key,
    person_name: name,
    profile,
    memories,
    system_prompt: record && record.system_prompt != null ? String(record.system_prompt) : '',
    sources: Array.isArray(record && record.sources) ? record.sources : [],
    source_archive,
    revisions,
    consent: consent === undefined ? null : consent,
    updated_at: now
  };
  if (existing && existing.created_at) {
    doc.created_at = existing.created_at;
    await folder.replaceOne({ _id: key }, doc);
  } else {
    doc.created_at = now;
    await folder.updateOne({ _id: key }, { $set: doc }, { upsert: true });
  }
  return doc;
}

async function patchPersonProfile(userId, personName, patch = {}) {
  const existing = await getPersonProfile(userId, personName);
  if (!existing) return null;
  const profile = { ...(existing.profile || {}), ...(patch.profile || {}) };
  const memories = patch.memories != null ? ensureMemoryIds(patch.memories) : existing.memories;
  if (Array.isArray(memories)) profile.memories = memories;
  const system_prompt = patch.system_prompt != null ? String(patch.system_prompt) : existing.system_prompt;
  return savePersonProfile(userId, existing.person_name, {
    profile,
    memories,
    system_prompt,
    sources: existing.sources,
    source_archive: [],
    consent: patch.consent !== undefined ? patch.consent : existing.consent
  });
}

async function deletePersonProfile(userId, personName) {
  const id = String(userId);
  const name = String(personName || '').trim();
  if (!name) return false;
  const folder = await ensureProfilesFolder(id);
  const key = personKeyForName(name);
  const result = await folder.deleteOne({ _id: key });
  return result.deletedCount > 0;
}

function findMemoryIndex(memories, memoryId) {
  const id = String(memoryId || '');
  return (memories || []).findIndex(mem => mem && String(mem.id) === id);
}

async function patchPersonMemory(userId, personName, memoryId, patch = {}) {
  const existing = await getPersonProfile(userId, personName);
  if (!existing) return null;
  const memories = Array.isArray(existing.memories) ? existing.memories.slice() : [];
  const index = findMemoryIndex(memories, memoryId);
  if (index < 0) return null;
  memories[index] = { ...memories[index], ...patch, id: memories[index].id };
  const saved = await savePersonProfile(userId, existing.person_name, {
    profile: { ...(existing.profile || {}), memories },
    memories,
    system_prompt: existing.system_prompt,
    sources: existing.sources,
    source_archive: [],
    consent: existing.consent
  });
  return saved.memories[index];
}

async function deletePersonMemory(userId, personName, memoryId) {
  const existing = await getPersonProfile(userId, personName);
  if (!existing) return null;
  const memories = (existing.memories || []).filter(mem => mem && String(mem.id) !== String(memoryId));
  if (memories.length === (existing.memories || []).length) return null;
  return savePersonProfile(userId, existing.person_name, {
    profile: { ...(existing.profile || {}), memories },
    memories,
    system_prompt: existing.system_prompt,
    sources: existing.sources,
    source_archive: [],
    consent: existing.consent
  });
}

async function restorePersonProfileRevision(userId, personName, index) {
  const existing = await getPersonProfile(userId, personName);
  if (!existing) return null;
  const revisions = existing.revisions || [];
  const rev = revisions[Number(index)];
  if (!rev) return null;
  return savePersonProfile(userId, existing.person_name, {
    profile: rev.profile,
    memories: rev.memories,
    system_prompt: rev.system_prompt,
    sources: rev.sources,
    source_archive: [],
    consent: existing.consent
  });
}

async function getPersonProfile(userId, personName) {
  const id = String(userId);
  const name = String(personName || '').trim();
  if (!name) return null;
  const folder = await ensureProfilesFolder(id);
  const key = personKeyForName(name);
  const byKey = await folder.findOne({ _id: key });
  if (byKey) return byKey;
  return folder.findOne({ user_id: id, person_name: name });
}

async function listPersonProfiles(userId) {
  const id = String(userId);
  const folder = await ensureProfilesFolder(id);
  const rows = await folder
    .find(
      { user_id: id },
      { projection: { person_name: 1, person_key: 1, updated_at: 1, created_at: 1, 'profile.summary': 1, memories: 1 } }
    )
    .sort({ updated_at: -1 })
    .toArray();
  return rows.map(row => ({
    person_name: row.person_name,
    person_key: row.person_key || row._id,
    summary: row.profile && row.profile.summary ? row.profile.summary : '',
    memory_count: Array.isArray(row.memories)
      ? row.memories.length
      : (row.profile && Array.isArray(row.profile.memories) ? row.profile.memories.length : 0),
    created_at: row.created_at,
    updated_at: row.updated_at
  }));
}

module.exports = {
  initDb,
  closeDb,
  storeMessage,
  getLastMessages,
  getCharacterFacts,
  updateCharacterFacts,
  savePersonProfile,
  getPersonProfile,
  listPersonProfiles,
  patchPersonProfile,
  deletePersonProfile,
  patchPersonMemory,
  deletePersonMemory,
  restorePersonProfileRevision,
  ensureChatFolder,
  ensureFactsFolder,
  ensureProfilesFolder,
  migrateLegacyMemory,
  listUserFolders,
  parseFactEntries,
  client,
  DB_NAME,
  COLLECTION_NAME,
  CHAT_LIMIT,
  FACT_LIMIT,
  MODEL_HISTORY_LIMIT
};
