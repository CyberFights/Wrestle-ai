#!/usr/bin/env node
'use strict';

/*
 * migrate.js — copy existing history into the MongoDB memory files used by the
 * app (Railway's MONGO_URL).
 *
 * Sources:
 *   • the old SQLite database (wrestling_bot.db) — default
 *   • the previous MySQL database  — pass --from-mysql "mysql://user:pass@host:3306/railway"
 *
 * Usage:
 *   MONGO_URL="mongodb://user:pass@host:27017" node migrate.js [path/to/wrestling_bot.db]
 *   node migrate.js path/to/wrestling_bot.db --url "mongodb://user:pass@host:27017"
 *   node migrate.js --from-mysql "mysql://user:pass@host:3306/railway" --url "mongodb://…"
 *
 * Everything ends up in each user's own memory folders — TWO per-user MongoDB
 * collections each holding one memory file:
 *   <base>_chats → { _id: <user_id>, chats: [...] }
 *   <base>_facts → { _id: <user_id>, character_facts: "…", matches: [...], key_facts: [...] }
 * where <base> is memory_r_<user_id>, memory_b_<…>, or memory_h_<…>.
 *
 * Users still living in the old flat `memory` collection are split into their
 * own folders first. Idempotent: chats already present in a chats file (from a
 * previous run or from the app itself) are detected and skipped, so running it
 * twice is safe.
 *
 * The SQLite source requires Node >= 22.13 (built-in node:sqlite) or the
 * better-sqlite3 package; the MySQL source requires the mysql2 package.
 */

const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const {
  chatFolderNameForUser,
  factsFolderNameForUser,
  isUserFolderName,
  isChatFolderName,
  isFactsFolderName
} = require('./memoryFolders');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let dbPath = null;
  let url = null;
  let mysqlUrl = null;
  let dbName = null;
  let collectionName = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--url' || argv[i] === '--mongo-url') {
      url = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--from-mysql') {
      mysqlUrl = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--db') {
      dbName = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--collection') {
      collectionName = argv[i + 1];
      i += 1;
    } else if (!argv[i].startsWith('-') && dbPath === null) {
      dbPath = argv[i];
    }
  }
  return { dbPath, url, mysqlUrl, dbName, collectionName };
}

const { dbPath, url, mysqlUrl, dbName, collectionName } = parseArgs(process.argv.slice(2));

const MONGO_URL =
  url ||
  process.env.MONGO_URL ||
  process.env.MONGODB_URI ||
  process.env.MONGO_PUBLIC_URL ||
  process.env.DATABASE_URL;
const MYSQL_URL = mysqlUrl || process.env.MYSQL_URL;
const DB_NAME = dbName || process.env.MONGO_DB_NAME || dbNameFromUrl(MONGO_URL) || 'wrestling_bot';
const COLLECTION_NAME = collectionName || process.env.MONGO_MEMORY_COLLECTION || 'memory';
const DB_FILE = path.resolve(dbPath || path.join(process.cwd(), 'wrestling_bot.db'));

// Same rule as the app: use the database from the URL when it has one.
function dbNameFromUrl(url) {
  if (!url) return null;
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

function toPositiveInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const CHAT_LIMIT = toPositiveInt(process.env.MEMORY_CHAT_LIMIT, 2000);
const FACT_LIMIT = toPositiveInt(process.env.MEMORY_FACT_LIMIT, 500);

if (!MONGO_URL) {
  console.error('No MongoDB URL provided. Set MONGO_URL or pass --url "mongodb://…"');
  process.exit(1);
}
if (!MYSQL_URL && !fs.existsSync(DB_FILE)) {
  console.error(`SQLite database not found: ${DB_FILE}`);
  console.error('Pass the path to your old database, e.g.  node migrate.js /path/to/wrestling_bot.db');
  console.error('…or migrate from the previous MySQL database with  --from-mysql "mysql://…"');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function openSqlite(file) {
  if (process.env.MIGRATE_SQLITE_DRIVER === 'better-sqlite3') {
    return openBetterSqlite(file);
  }
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    return {
      driver: 'node:sqlite',
      all(sql) { return db.prepare(sql).all(); },
      close() { db.close(); }
    };
  } catch (err) {
    return openBetterSqlite(file, err);
  }
}

function openBetterSqlite(file, previousError) {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(file, { readonly: true });
    return {
      driver: 'better-sqlite3',
      all(sql) { return db.prepare(sql).all(); },
      close() { db.close(); }
    };
  } catch (err) {
    throw new Error(
      'Could not open the SQLite database. This script needs Node >= 22.13 ' +
      '(built-in node:sqlite) or the better-sqlite3 package (npm install).\n' +
      (previousError ? `  node:sqlite error: ${previousError.message}\n` : '') +
      `  better-sqlite3 error: ${err.message}`
    );
  }
}

// Reads the old tables out of SQLite.
function readFromSqlite(file) {
  const sqlite = openSqlite(file);
  console.log(`Reading ${file} with ${sqlite.driver}…`);
  try {
    let conversations = [];
    let memory = [];
    try {
      conversations = sqlite.all('SELECT user_id, message, role, timestamp FROM conversations ORDER BY rowid');
    } catch (err) {
      console.warn(`  conversations table not found in SQLite, skipping (${err.message})`);
    }
    try {
      memory = sqlite.all('SELECT user_id, character_facts FROM memory');
    } catch (err) {
      console.warn(`  memory table not found in SQLite, skipping (${err.message})`);
    }
    return { conversations, memory };
  } finally {
    try {
      sqlite.close();
    } catch (err) {
      // already closed — fine
    }
  }
}

// Reads the old tables out of the previous MySQL database.
async function readFromMysql(connectionUrl) {
  let mysql;
  try {
    mysql = require('mysql2/promise');
  } catch (err) {
    throw new Error(
      'Reading from MySQL needs the mysql2 package. Install it first:  npm install mysql2\n' +
      `  ${err.message}`
    );
  }

  console.log('Reading the previous MySQL database…');
  const connection = await mysql.createConnection({
    uri: connectionUrl.replace(/^mysql2:\/\//, 'mysql://'),
    charset: 'utf8mb4',
    connectTimeout: 10000,
    dateStrings: true
  });

  try {
    let conversations = [];
    let memory = [];
    try {
      const [rows] = await connection.query('SELECT user_id, message, role, timestamp FROM conversations ORDER BY id');
      conversations = rows;
    } catch (err) {
      console.warn(`  conversations table not found in MySQL, skipping (${err.message})`);
    }
    try {
      const [rows] = await connection.query('SELECT user_id, character_facts FROM memory');
      memory = rows;
    } catch (err) {
      console.warn(`  memory table not found in MySQL, skipping (${err.message})`);
    }
    return { conversations, memory };
  } finally {
    await connection.end();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// SQLite/MySQL store timestamps as 'YYYY-MM-DD HH:MM:SS' (UTC).
// Accept 'T' separators and Date objects too.
function normalizeTimestamp(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (!m) return null;
  const date = new Date(`${m[1]}T${m[2]}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Fingerprint of one chat entry, used to skip entries that are already in the
// memory file (there is no unique key to rely on).
function chatFingerprint(role, message, timestamp) {
  return JSON.stringify([role, message, timestamp ? timestamp.toISOString() : null]);
}

// Same segment parsing as the app: " | New match discussed: …" / " | Notable event: …"
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let source;
  try {
    source = MYSQL_URL ? await readFromMysql(MYSQL_URL) : readFromSqlite(DB_FILE);
  } catch (err) {
    console.error(`Could not read the source database: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const client = new MongoClient(MONGO_URL, {
    connectTimeoutMS: 10000,
    serverSelectionTimeoutMS: 10000
  });

  try {
    await client.connect();
    const database = client.db(DB_NAME);

    // Each user's typed memory folders. `createIndex` also creates the
    // collection on first use, so a new user gets their folders here.
    const indexedFolders = new Set();
    async function ensureFolderByName(name) {
      const folder = database.collection(name);
      if (!indexedFolders.has(name)) {
        await folder.createIndex({ user_id: 1 });
        indexedFolders.add(name);
      }
      return folder;
    }
    const ensureChatFolder = userId => ensureFolderByName(chatFolderNameForUser(userId));
    const ensureFactsFolder = userId => ensureFolderByName(factsFolderNameForUser(userId));

    // Splits one old-style memory file (chats and/or facts in a single
    // document) into the user's typed folders, never overwriting files that
    // already exist. Returns true when something was written.
    async function splitLegacyFile(doc) {
      const legacyUserId = doc.user_id != null
        ? String(doc.user_id)
        : (doc._id != null ? String(doc._id) : '');
      if (!legacyUserId) return false;

      const now = new Date();
      let migrated = false;

      const chats = Array.isArray(doc.chats) ? doc.chats : [];
      if (chats.length) {
        const chatFolder = await ensureChatFolder(legacyUserId);
        if (!(await chatFolder.findOne({ _id: legacyUserId }))) {
          await chatFolder.insertOne({
            _id: legacyUserId,
            user_id: legacyUserId,
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
        const factsFolder = await ensureFactsFolder(legacyUserId);
        if (!(await factsFolder.findOne({ _id: legacyUserId }))) {
          await factsFolder.insertOne({
            _id: legacyUserId,
            user_id: legacyUserId,
            character_facts: doc.character_facts != null ? String(doc.character_facts) : '',
            matches: Array.isArray(doc.matches) ? doc.matches : [],
            key_facts: Array.isArray(doc.key_facts) ? doc.key_facts : [],
            created_at: doc.created_at || now,
            updated_at: doc.updated_at || now
          });
          migrated = true;
        }
      }

      return migrated;
    }

    // ---- split users out of the old flat `memory` collection into folders ----
    let legacyMigrated = 0;
    let legacySkipped = 0;
    let legacyFound = false;
    try {
      legacyFound = await database.listCollections({ name: COLLECTION_NAME }, { nameOnly: true }).hasNext();
    } catch (err) {
      legacyFound = false;
    }
    if (legacyFound) {
      const legacy = database.collection(COLLECTION_NAME);
      const legacyCursor = legacy.find({});
      while (await legacyCursor.hasNext()) {
        const doc = await legacyCursor.next();
        if (await splitLegacyFile(doc)) legacyMigrated += 1;
        else legacySkipped += 1;
      }
    }

    // ---- group the source rows per user ----
    const users = new Map();
    function userEntry(rawUserId) {
      const userId = rawUserId == null ? '' : String(rawUserId);
      if (!users.has(userId)) users.set(userId, { chats: [], characterFacts: null });
      return users.get(userId);
    }

    let convBadUsers = 0;
    for (const row of source.conversations) {
      const userId = row.user_id == null ? '' : String(row.user_id);
      if (!userId) {
        convBadUsers += 1;
        continue;
      }
      userEntry(userId).chats.push({
        role: row.role == null ? '' : String(row.role),
        message: row.message == null ? '' : String(row.message),
        timestamp: normalizeTimestamp(row.timestamp)
      });
    }

    let memBadUsers = 0;
    for (const row of source.memory) {
      const userId = row.user_id == null ? '' : String(row.user_id);
      if (!userId) {
        memBadUsers += 1;
        continue;
      }
      userEntry(userId).characterFacts = row.character_facts == null ? '' : String(row.character_facts);
    }

    // ---- merge into the memory files (chats → chats folder, facts → facts folder) ----
    let insertedChats = 0;
    let skippedChats = 0;
    let trimmedChats = 0;
    let newChatFiles = 0;
    let updatedChatFiles = 0;
    let newFactFiles = 0;
    let updatedFactFiles = 0;
    let factsWritten = 0;
    let factsKept = 0;

    for (const [userId, entry] of users) {
      const now = new Date();

      // ---- chats file ----
      const chatFolder = await ensureChatFolder(userId);
      const existingChatFile = await chatFolder.findOne({ _id: userId });

      // chats — keep what is already there, add only the missing ones
      const existingChats = (existingChatFile && Array.isArray(existingChatFile.chats) ? existingChatFile.chats : []).map(chat => ({
        role: chat.role == null ? '' : String(chat.role),
        message: chat.message == null ? '' : String(chat.message),
        timestamp: chat.timestamp instanceof Date ? chat.timestamp : normalizeTimestamp(chat.timestamp)
      }));
      const seen = new Set(existingChats.map(c => chatFingerprint(c.role, c.message, c.timestamp)));
      const seenWithoutTime = new Set(existingChats.map(c => `${c.role}|${c.message}`));

      const toAdd = [];
      for (const chat of entry.chats) {
        // Entries without a usable source timestamp are matched by content alone.
        const key = chat.timestamp
          ? chatFingerprint(chat.role, chat.message, chat.timestamp)
          : `${chat.role}|${chat.message}`;
        const pool = chat.timestamp ? seen : seenWithoutTime;
        if (pool.has(key)) {
          skippedChats += 1;
          continue;
        }
        pool.add(key);
        toAdd.push({ ...chat, timestamp: chat.timestamp || now });
      }

      let mergedChats = existingChats.concat(toAdd);
      mergedChats.sort((a, b) => {
        const at = a.timestamp ? a.timestamp.getTime() : 0;
        const bt = b.timestamp ? b.timestamp.getTime() : 0;
        return at - bt;
      });
      if (mergedChats.length > CHAT_LIMIT) {
        trimmedChats += mergedChats.length - CHAT_LIMIT;
        mergedChats = mergedChats.slice(-CHAT_LIMIT);
      }

      // Skip writing an empty chats file for users that only have facts.
      if (mergedChats.length || existingChatFile) {
        await chatFolder.updateOne(
          { _id: userId },
          {
            $setOnInsert: { user_id: userId, created_at: now },
            $set: { chats: mergedChats, updated_at: now }
          },
          { upsert: true }
        );
        if (existingChatFile) updatedChatFiles += 1;
        else newChatFiles += 1;
      }
      insertedChats += toAdd.length;

      // ---- facts file ----
      const factsFolder = await ensureFactsFolder(userId);
      const existingFactFile = await factsFolder.findOne({ _id: userId });

      // character facts — never overwrite what the app already stored
      const existingFacts = existingFactFile && existingFactFile.character_facts != null
        ? String(existingFactFile.character_facts)
        : '';
      let characterFacts = existingFacts;
      if (entry.characterFacts) {
        if (existingFacts) factsKept += 1;
        else {
          characterFacts = entry.characterFacts;
          factsWritten += 1;
        }
      }

      // matches / key facts — rebuilt from the memory string
      const parsed = parseFactEntries(characterFacts);
      const existingMatches = existingFactFile && Array.isArray(existingFactFile.matches) ? existingFactFile.matches : [];
      const existingKeyFacts = existingFactFile && Array.isArray(existingFactFile.key_facts) ? existingFactFile.key_facts : [];
      const knownMatches = new Set(existingMatches.map(m => (m && m.text != null ? String(m.text) : '')));
      const knownKeyFacts = new Set(existingKeyFacts.map(m => (m && m.text != null ? String(m.text) : '')));

      const matches = existingMatches.concat(
        parsed.matches.filter(text => !knownMatches.has(text)).map(text => ({ text, timestamp: now }))
      ).slice(-FACT_LIMIT);
      const keyFacts = existingKeyFacts.concat(
        parsed.keyFacts.filter(text => !knownKeyFacts.has(text)).map(text => ({ text, timestamp: now }))
      ).slice(-FACT_LIMIT);

      // Skip writing an empty facts file for users that only have chats.
      if (characterFacts || matches.length || keyFacts.length || existingFactFile) {
        await factsFolder.updateOne(
          { _id: userId },
          {
            $setOnInsert: { user_id: userId, created_at: now },
            $set: {
              matches,
              key_facts: keyFacts,
              character_facts: characterFacts,
              updated_at: now
            }
          },
          { upsert: true }
        );
        if (existingFactFile) updatedFactFiles += 1;
        else newFactFiles += 1;
      }
    }

    console.log(
      `chats: ${source.conversations.length} read, ${insertedChats} added, ${skippedChats} already present` +
      (trimmedChats ? `, ${trimmedChats} trimmed (older than the last ${CHAT_LIMIT})` : '') +
      (convBadUsers ? `, ${convBadUsers} skipped (empty user_id)` : '')
    );
    console.log(
      `character facts: ${source.memory.length} read, ${factsWritten} written, ${factsKept} left untouched (already in MongoDB)` +
      (memBadUsers ? `, ${memBadUsers} skipped (empty user_id)` : '')
    );
    console.log(
      `memory files: ${newChatFiles} chats file(s) created, ${updatedChatFiles} updated — ` +
      `${newFactFiles} facts file(s) created, ${updatedFactFiles} updated`
    );
    if (legacyFound) {
      console.log(
        `legacy "memory" collection: ${legacyMigrated} memory file(s) split into chats/facts folders, ` +
        `${legacySkipped} skipped (already in place or empty)`
      );
    }

    // ---- verification (summed across the typed user folders) ----
    const chatFolderNames = [];
    const factsFolderNames = [];
    let legacyCombined = 0;
    const folderCursor = database.listCollections({}, { nameOnly: true });
    while (await folderCursor.hasNext()) {
      const { name } = await folderCursor.next();
      if (!isUserFolderName(name)) continue;
      if (isChatFolderName(name)) chatFolderNames.push(name);
      else if (isFactsFolderName(name)) factsFolderNames.push(name);
      else legacyCombined += 1;
    }

    async function sumArrayField(names, field) {
      let total = 0;
      for (const name of names) {
        const [totals] = await database.collection(name).aggregate([
          { $group: { _id: null, n: { $sum: { $size: { $ifNull: [`$${field}`, []] } } } } }
        ]).toArray();
        if (totals) total += totals.n;
      }
      return total;
    }

    const totalChats = await sumArrayField(chatFolderNames, 'chats');
    const totalMatches = await sumArrayField(factsFolderNames, 'matches');
    const totalKeyFacts = await sumArrayField(factsFolderNames, 'key_facts');

    console.log(
      `\nVerification — ${DB_NAME} now holds ${chatFolderNames.length} chats folder(s) with ${totalChats} chats ` +
      `and ${factsFolderNames.length} facts folder(s) with ${totalMatches} matches and ${totalKeyFacts} key facts.` +
      (legacyCombined
        ? `\n${legacyCombined} old combined folder(s) still present — the app splits them into chats/facts folders automatically on startup.`
        : '')
    );
  } catch (err) {
    console.error(`Migration failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    try {
      await client.close();
    } catch (err) {
      console.error(`Warning: could not close the MongoDB client cleanly: ${err.message}`);
    }
  }
}

main();
