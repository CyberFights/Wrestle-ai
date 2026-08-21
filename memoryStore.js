'use strict';

/*
 * memoryStore.js — MongoDB storage layer.
 *
 * Everything the bot remembers about a user lives in ONE document ("memory
 * file") per user_id, inside a single collection:
 *
 *   {
 *     _id: "<user_id>",              // the user id is the document key
 *     user_id: "<user_id>",
 *     chats:     [ { role, message, timestamp } ],   // conversation history
 *     matches:   [ { text, timestamp } ],            // matches that came up
 *     key_facts: [ { text, timestamp } ],            // notable events / facts
 *     character_facts: "…",          // the memory string fed to the model
 *     created_at, updated_at
 *   }
 *
 * Railway injects MONGO_URL automatically when a MongoDB database is attached
 * to the service.
 */

const { MongoClient } = require('mongodb');

const MONGO_URL =
  process.env.MONGO_URL ||
  process.env.MONGODB_URI ||
  process.env.MONGO_PUBLIC_URL ||
  process.env.DATABASE_URL;

if (!MONGO_URL) {
  throw new Error('MONGO_URL env variable not set (Railway sets it automatically when a MongoDB database is attached)');
}

const DB_NAME = process.env.MONGO_DB_NAME || dbNameFromUrl(MONGO_URL) || 'wrestling_bot';
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

let collection = null;

function memoryFiles() {
  if (!collection) throw new Error('MongoDB is not connected yet — call initDb() first');
  return collection;
}

async function initDb() {
  await client.connect();
  const db = client.db(DB_NAME);
  collection = db.collection(COLLECTION_NAME);
  // The user id is the _id, which is always indexed; this mirror index just
  // makes ad-hoc lookups by user_id fast too.
  await collection.createIndex({ user_id: 1 });
  return collection;
}

async function closeDb() {
  collection = null;
  await client.close();
}

// ---------- CHATS ----------

async function storeMessage(userId, message, role) {
  const id = String(userId);
  const now = new Date();
  await memoryFiles().updateOne(
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
  const doc = await memoryFiles().findOne(
    { _id: String(userId) },
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
  const doc = await memoryFiles().findOne(
    { _id: String(userId) },
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

  await memoryFiles().updateOne({ _id: id }, update, { upsert: true });
}

module.exports = {
  initDb,
  closeDb,
  storeMessage,
  getLastMessages,
  getCharacterFacts,
  updateCharacterFacts,
  parseFactEntries,
  client,
  DB_NAME,
  COLLECTION_NAME,
  CHAT_LIMIT,
  FACT_LIMIT
};
