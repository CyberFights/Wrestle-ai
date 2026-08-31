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
  isUserFolderName,
  isChatFolderName,
  isFactsFolderName,
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
    if (isUserFolderName(name) && !isChatFolderName(name) && !isFactsFolderName(name)) {
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

module.exports = {
  initDb,
  closeDb,
  storeMessage,
  getLastMessages,
  getCharacterFacts,
  updateCharacterFacts,
  ensureChatFolder,
  ensureFactsFolder,
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
