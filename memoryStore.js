'use strict';

/*
 * memoryStore.js — MongoDB storage layer.
 *
 * The bot keeps its memory inside a MongoDB database (the "memory folder").
 * Each user gets their OWN collection inside that database — their own folder —
 * and everything the bot remembers about that user (chats, matches, key facts,
 * character facts) is stored in, and pulled from, that folder. Inside the
 * folder everything lives in ONE document ("memory file") keyed by the user id:
 *
 *   memory_r_<user_id>  →  {
 *     _id: "<user_id>",               // the user id is the document key
 *     user_id: "<user_id>",
 *     chats:     [ { role, message, timestamp } ],   // conversation history
 *     matches:   [ { text, timestamp } ],            // matches that came up
 *     key_facts: [ { text, timestamp } ],            // notable events / facts
 *     character_facts: "…",          // the memory string fed to the model
 *     created_at, updated_at
 *   }
 *
 * A folder is created automatically the first time a new user shows up. On
 * startup, any users still living in the old flat `memory` collection are moved
 * into their own folders, so nothing is lost when upgrading.
 *
 * Railway injects MONGO_URL automatically when a MongoDB database is attached
 * to the service.
 */

const { MongoClient } = require('mongodb');
const { collectionNameForUser, isUserFolderName } = require('./memoryFolders');

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

// Collection names whose folder has already been created + indexed this run.
const knownFolders = new Set();

function isNamespaceExistsError(err) {
  return Boolean(err) && (err.code === 48 || err.codeName === 'NamespaceExists');
}

// Returns (creating it on first use) the user's own memory folder collection.
async function ensureUserFolder(userId) {
  if (!db) throw new Error('MongoDB is not connected yet — call initDb() first');
  const name = collectionNameForUser(userId);

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

async function initDb() {
  await client.connect();
  db = client.db(DB_NAME);

  // Move any users still stored in the old flat collection into their own
  // folders. Idempotent: folders that already have the user are left alone.
  const legacy = await migrateLegacyMemory();
  if (legacy.found) {
    console.log(
      `Memory folders: ${legacy.migrated} user(s) moved from the legacy "${COLLECTION_NAME}" ` +
      `collection, ${legacy.skipped} already in their own folder.`
    );
  }
  return db;
}

async function closeDb() {
  db = null;
  knownFolders.clear();
  await client.close();
}

// One-time, idempotent upgrade: copy documents out of the old flat `memory`
// collection into each user's own folder.
async function migrateLegacyMemory() {
  if (!db) throw new Error('MongoDB is not connected yet — call initDb() first');

  let found = false;
  try {
    found = await db.listCollections({ name: COLLECTION_NAME }, { nameOnly: true }).hasNext();
  } catch (err) {
    found = false;
  }
  if (!found) return { found: false, migrated: 0, skipped: 0 };

  const legacy = db.collection(COLLECTION_NAME);
  let migrated = 0;
  let skipped = 0;

  const cursor = legacy.find({});
  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    const userId = doc.user_id != null
      ? String(doc.user_id)
      : (doc._id != null ? String(doc._id) : '');
    if (!userId) {
      skipped += 1;
      continue;
    }

    const folder = await ensureUserFolder(userId);
    const alreadyThere = await folder.findOne({ _id: userId });
    if (alreadyThere) {
      skipped += 1;
      continue;
    }

    await folder.insertOne({ ...doc, _id: userId, user_id: userId });
    migrated += 1;
  }

  return { found: true, migrated, skipped };
}

// Names of every per-user memory folder currently in the database.
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

// ---------- CHATS ----------

async function storeMessage(userId, message, role) {
  const id = String(userId);
  const now = new Date();
  const folder = await ensureUserFolder(id);
  await folder.updateOne(
    { _id: id },
    {
      $setOnInsert: {
        user_id: id,
        character_facts: '',
        matches: [],
        key_facts: [],
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

async function getLastMessages(userId, limit = 10) {
  const safeLimit = Math.max(1, Math.min(100, parseInt(limit, 10) || 10));
  const id = String(userId);
  const folder = await ensureUserFolder(id);
  const doc = await folder.findOne(
    { _id: id },
    { projection: { chats: { $slice: -safeLimit } } }
  );
  const chats = (doc && doc.chats) || [];
  return chats.map(chat => ({ role: chat.role, content: chat.message }));
}

// ---------- MATCHES + KEY FACTS ----------

// The app builds its memory string by appending segments like
//   " | New match discussed: <message>"  and  " | Notable event: <message>".
// Those segments are split back out here so the memory file also keeps them as
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

async function getCharacterFacts(userId) {
  const id = String(userId);
  const folder = await ensureUserFolder(id);
  const doc = await folder.findOne(
    { _id: id },
    { projection: { character_facts: 1 } }
  );
  return doc && doc.character_facts != null ? doc.character_facts : '';
}

async function updateCharacterFacts(userId, facts) {
  const id = String(userId);
  const now = new Date();
  const nextFacts = facts == null ? '' : String(facts);
  const previousFacts = await getCharacterFacts(id);

  // Only the part that was just appended becomes new matches / key facts.
  const delta = nextFacts.startsWith(previousFacts)
    ? nextFacts.slice(previousFacts.length)
    : nextFacts;
  const { matches, keyFacts } = parseFactEntries(delta);

  const setOnInsert = { user_id: id, chats: [], created_at: now };
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

  const folder = await ensureUserFolder(id);
  await folder.updateOne({ _id: id }, update, { upsert: true });
}

module.exports = {
  initDb,
  closeDb,
  storeMessage,
  getLastMessages,
  getCharacterFacts,
  updateCharacterFacts,
  ensureUserFolder,
  migrateLegacyMemory,
  listUserFolders,
  parseFactEntries,
  client,
  DB_NAME,
  COLLECTION_NAME,
  CHAT_LIMIT,
  FACT_LIMIT
};
