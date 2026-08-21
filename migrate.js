#!/usr/bin/env node
'use strict';

/*
 * migrate.js — copy history from the old SQLite database (wrestling_bot.db)
 * into the MySQL database used by the app (Railway's MYSQL_URL).
 *
 * Usage:
 *   MYSQL_URL="mysql://user:pass@host:3306/railway" node migrate.js [path/to/wrestling_bot.db]
 *   node migrate.js path/to/wrestling_bot.db --url "mysql://user:pass@host:3306/railway"
 *
 * Copies both tables (conversations and memory) and preserves timestamps.
 * Idempotent: rows that already exist in MySQL (from a previous run or from
 * the app itself) are detected and skipped, so running it twice is safe.
 *
 * Requires Node >= 22.13 (built-in node:sqlite) or the better-sqlite3 package.
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let dbPath = null;
  let url = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--url') {
      url = argv[i + 1];
      i += 1;
    } else if (!argv[i].startsWith('-') && dbPath === null) {
      dbPath = argv[i];
    }
  }
  return { dbPath, url };
}

const { dbPath, url } = parseArgs(process.argv.slice(2));
const MYSQL_URL = url || process.env.MYSQL_URL || process.env.DATABASE_URL;
const DB_FILE = path.resolve(dbPath || path.join(process.cwd(), 'wrestling_bot.db'));
const BATCH_SIZE = 250;

if (!MYSQL_URL) {
  console.error('No MySQL URL provided. Set MYSQL_URL or pass --url "mysql://..."');
  process.exit(1);
}
if (!fs.existsSync(DB_FILE)) {
  console.error(`SQLite database not found: ${DB_FILE}`);
  console.error('Pass the path to your old database, e.g.  node migrate.js /path/to/wrestling_bot.db');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// SQLite reader — node:sqlite (Node >= 22.13) or better-sqlite3 (fallback)
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// SQLite stores CURRENT_TIMESTAMP as 'YYYY-MM-DD HH:MM:SS' (UTC).
// Accept 'T' separators too; anything else falls back to the DB default.
function normalizeTimestamp(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : null;
}

// Fingerprint of one conversation row, used to skip rows that were already
// migrated on a previous run (the table has no unique key to rely on).
function conversationFingerprint(userId, message, role, timestamp) {
  return JSON.stringify([userId, message, role, timestamp]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const sqlite = openSqlite(DB_FILE);
  console.log(`Reading ${DB_FILE} with ${sqlite.driver}…`);

  const pool = mysql.createPool({
    uri: MYSQL_URL.replace(/^mysql2:\/\//, 'mysql://'),
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 5,
    connectTimeout: 10000,
    dateStrings: true // return DATETIME as 'YYYY-MM-DD HH:MM:SS' so fingerprints match
  });

  // Rows already present in MySQL (from a previous migration run or from the
  // app itself) are skipped, so re-running the migration is safe.
  async function getExistingFingerprints(userIds) {
    if (!userIds.length) return new Set();
    const [rows] = await pool.execute(
      `SELECT user_id, message, role, timestamp FROM conversations
       WHERE user_id IN (${userIds.map(() => '?').join(',')})`,
      userIds
    );
    return new Set(rows.map(r => conversationFingerprint(
      String(r.user_id ?? ''),
      String(r.message ?? ''),
      String(r.role ?? ''),
      normalizeTimestamp(r.timestamp)
    )));
  }

  try {
    // Same schema as wrestling.js
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id TEXT,
        message TEXT,
        role TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS memory (
        user_id VARCHAR(191) PRIMARY KEY,
        character_facts TEXT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // ---- conversations ----
    let convRows = [];
    try {
      convRows = sqlite.all('SELECT user_id, message, role, timestamp FROM conversations ORDER BY rowid');
    } catch (err) {
      console.warn(`  conversations table not found in SQLite, skipping (${err.message})`);
    }

    let inserted = 0;
    let skipped = 0;
    let convBadUsers = 0;

    for (let i = 0; i < convRows.length; i += BATCH_SIZE) {
      const batch = convRows.slice(i, i + BATCH_SIZE);

      // Normalize the batch rows first
      const normalized = [];
      for (const r of batch) {
        const userId = r.user_id == null ? '' : String(r.user_id);
        if (userId.length > 191) {
          convBadUsers += 1;
          continue;
        }
        normalized.push([
          userId,
          r.message == null ? '' : String(r.message),
          r.role == null ? '' : String(r.role),
          normalizeTimestamp(r.timestamp)
        ]);
      }
      if (!normalized.length) continue;

      // Skip rows that are already in MySQL
      const userIds = [...new Set(normalized.map(row => row[0]))];
      const existing = await getExistingFingerprints(userIds);

      // Rows without a usable source timestamp get CURRENT_TIMESTAMP at
      // insert, so on a re-run they are matched by content alone.
      const nullTimestampRows = normalized.filter(row => row[3] === null);
      let anyTimestamp = new Set();
      if (nullTimestampRows.length) {
        const [rows] = await pool.execute(
          `SELECT user_id, message, role FROM conversations
           WHERE user_id IN (${userIds.map(() => '?').join(',')})`,
          userIds
        );
        anyTimestamp = new Set(rows.map(r => `${r.user_id}|${r.message}|${r.role}`));
      }

      const toInsert = normalized.filter(row => {
        if (row[3] === null) {
          const key = `${row[0]}|${row[1]}|${row[2]}`;
          if (anyTimestamp.has(key)) {
            skipped += 1;
            return false;
          }
          return true;
        }
        const fp = conversationFingerprint(row[0], row[1], row[2], row[3]);
        if (existing.has(fp)) {
          skipped += 1;
          return false;
        }
        return true;
      });
      if (!toInsert.length) continue;

      const placeholders = toInsert.map(() => '(?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))').join(', ');
      const [result] = await pool.execute(
        `INSERT INTO conversations (user_id, message, role, timestamp) VALUES ${placeholders}`,
        toInsert.flat()
      );
      inserted += result.affectedRows;
    }

    console.log(`conversations: ${convRows.length} read, ${inserted} inserted, ${skipped} already present` +
      (convBadUsers ? `, ${convBadUsers} skipped (user_id longer than 191 chars)` : ''));

    // ---- memory ----
    let memRows = [];
    try {
      memRows = sqlite.all('SELECT user_id, character_facts FROM memory');
    } catch (err) {
      console.warn(`  memory table not found in SQLite, skipping (${err.message})`);
    }

    let memInserted = 0;
    let memSkipped = 0;
    let memBadUsers = 0;
    for (const r of memRows) {
      const userId = r.user_id == null ? '' : String(r.user_id);
      if (!userId || userId.length > 191) {
        memBadUsers += 1;
        continue;
      }
      const [result] = await pool.execute(
        'INSERT IGNORE INTO memory (user_id, character_facts) VALUES (?, ?)',
        [userId, r.character_facts == null ? '' : String(r.character_facts)]
      );
      if (result.affectedRows > 0) memInserted += 1;
      else memSkipped += 1;
    }

    console.log(`memory: ${memRows.length} read, ${memInserted} inserted, ${memSkipped} already present` +
      (memBadUsers ? `, ${memBadUsers} skipped (user_id longer than 191 chars)` : ''));

    // ---- verification ----
    const [[convCount]] = await pool.query('SELECT COUNT(*) AS n FROM conversations');
    const [[memCount]] = await pool.query('SELECT COUNT(*) AS n FROM memory');
    console.log(`\nVerification — MySQL now contains ${convCount.n} conversation rows and ${memCount.n} memory rows.`);
    if (convCount.n < convRows.length) {
      console.log('Note: MySQL already contained some of these rows (they were kept as-is).');
    }
  } catch (err) {
    console.error(`Migration failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    try {
      await pool.end();
    } catch (err) {
      console.error(`Warning: could not close the MySQL pool cleanly: ${err.message}`);
    }
    try {
      sqlite.close();
    } catch (err) {
      // already closed — fine
    }
  }
}

main();
