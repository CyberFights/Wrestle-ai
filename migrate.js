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
 * Everything ends up in one memory file per user id:
 *   { _id: <user_id>, chats: [...], matches: [...], key_facts: [...], character_facts: "…" }
 *
 * Idempotent: chats already present in the memory file (from a previous run or
 * from the app itself) are detected and skipped, so running it twice is safe.
 *
 * The SQLite source requires Node >= 22.13 (built-in node:sqlite) or the
 * better-sqlite3 package; the MySQL source requires the mysql2 package.
 */

const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

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
    const memoryFiles = client.db(DB_NAME).collection(COLLECTION_NAME);
    await memoryFiles.createIndex({ user_id: 1 });

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

    // ---- merge into the memory files ----
    let insertedChats = 0;
    let skippedChats = 0;
    let trimmedChats = 0;
    let newFiles = 0;
    let updatedFiles = 0;
    let factsWritten = 0;
    let factsKept = 0;

    for (const [userId, entry] of users) {
      const existing = await memoryFiles.findOne({ _id: userId });
      const now = new Date();

      // chats — keep what is already there, add only the missing ones
      const existingChats = (existing && Array.isArray(existing.chats) ? existing.chats : []).map(chat => ({
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

      // character facts — never overwrite what the app already stored
      const existingFacts = existing && existing.character_facts != null ? String(existing.character_facts) : '';
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
      const existingMatches = existing && Array.isArray(existing.matches) ? existing.matches : [];
      const existingKeyFacts = existing && Array.isArray(existing.key_facts) ? existing.key_facts : [];
      const knownMatches = new Set(existingMatches.map(m => (m && m.text != null ? String(m.text) : '')));
      const knownKeyFacts = new Set(existingKeyFacts.map(m => (m && m.text != null ? String(m.text) : '')));

      const matches = existingMatches.concat(
        parsed.matches.filter(text => !knownMatches.has(text)).map(text => ({ text, timestamp: now }))
      ).slice(-FACT_LIMIT);
      const keyFacts = existingKeyFacts.concat(
        parsed.keyFacts.filter(text => !knownKeyFacts.has(text)).map(text => ({ text, timestamp: now }))
      ).slice(-FACT_LIMIT);

      await memoryFiles.updateOne(
        { _id: userId },
        {
          $setOnInsert: { user_id: userId, created_at: now },
          $set: {
            chats: mergedChats,
            matches,
            key_facts: keyFacts,
            character_facts: characterFacts,
            updated_at: now
          }
        },
        { upsert: true }
      );

      insertedChats += toAdd.length;
      if (existing) updatedFiles += 1;
      else newFiles += 1;
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
    console.log(`memory files: ${newFiles} created, ${updatedFiles} updated`);

    // ---- verification ----
    const fileCount = await memoryFiles.countDocuments();
    const [totals] = await memoryFiles.aggregate([
      {
        $group: {
          _id: null,
          chats: { $sum: { $size: { $ifNull: ['$chats', []] } } },
          matches: { $sum: { $size: { $ifNull: ['$matches', []] } } },
          keyFacts: { $sum: { $size: { $ifNull: ['$key_facts', []] } } }
        }
      }
    ]).toArray();

    console.log(
      `\nVerification — ${DB_NAME}.${COLLECTION_NAME} now holds ${fileCount} memory file(s) with ` +
      `${totals ? totals.chats : 0} chats, ${totals ? totals.matches : 0} matches and ` +
      `${totals ? totals.keyFacts : 0} key facts.`
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
