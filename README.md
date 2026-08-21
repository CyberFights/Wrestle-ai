# Wrestle-ai

Custom Mistral-powered wrestling roleplay AI server.

Uses a **MongoDB** database (via the official `mongodb` driver) — designed to run on
[Railway](https://railway.app) with its MongoDB database.

## Environment variables

- `MONGO_URL` — MongoDB connection string, e.g. `mongodb://mongo:password@host:27017`.
  Railway sets this automatically when a MongoDB database is attached.
  `MONGODB_URI`, `MONGO_PUBLIC_URL` and `DATABASE_URL` are accepted as fallbacks.
- `MISTRAL_API_KEY` — Mistral AI API key.
- `PORT` — port to listen on (default `8080`).

Optional:

- `MONGO_DB_NAME` — database to use (default: the one in `MONGO_URL`, otherwise `wrestling_bot`).
- `MONGO_MEMORY_COLLECTION` — name of the legacy flat collection (default `memory`). Only used
  to migrate old data into per-user folders on startup.
- `MEMORY_CHAT_LIMIT` — how many chats each memory file keeps (default `2000`).
- `MEMORY_FACT_LIMIT` — how many matches / key facts each memory file keeps (default `500`).

## How memory is stored

The bot's memory lives in the MongoDB database (the "memory folder"). Inside it, **every
user gets their own folder** — their own MongoDB collection — and everything remembered
about that user is written to and pulled from that folder:

```
<database>/          ← the memory folder
├── memory_r_12345   ← one user's folder
├── memory_r_67890   ← another user's folder
└── …
```

The folder name is derived from the user id (`memory_r_<user_id>` for ids made of letters,
digits, `-` and `_`; `memory_b_<base64url>` or `memory_h_<sha256>` for anything else), so it
is always unique per user and always valid in MongoDB. A new user's folder is created
automatically the first time anything is stored or read for them.

Each folder holds **one memory file** — a single document keyed by the user id:

```jsonc
{
  "_id": "<user_id>",
  "user_id": "<user_id>",
  "chats":     [ { "role": "user", "message": "…", "timestamp": "…" } ],  // conversation history
  "matches":   [ { "text": "…", "timestamp": "…" } ],                     // matches that came up
  "key_facts": [ { "text": "…", "timestamp": "…" } ],                     // notable events / facts
  "character_facts": "…",   // the memory string sent to the model
  "created_at": "…",
  "updated_at": "…"
}
```

Folders and their indexes are created automatically. Because a MongoDB document maxes out
at 16 MB, each file keeps the most recent `MEMORY_CHAT_LIMIT` chats and `MEMORY_FACT_LIMIT`
matches / key facts.

On startup, any users still stored in the old flat `memory` collection (from a previous
version of this bot) are moved into their own folders automatically — this is idempotent,
so restarting never duplicates anything.

## Migrating your old history

`migrate.js` copies existing history into the MongoDB memory files, either from the old
SQLite database (`wrestling_bot.db`) or from the MySQL database this bot used before.

1. Get your Railway MongoDB URL — on the Railway dashboard, open the MongoDB service →
   **Variables** tab → copy `MONGO_URL` (or `MONGO_PUBLIC_URL` when running from your own machine).
2. Run the migration (from this folder):

   ```bash
   npm install

   # from the old SQLite database
   MONGO_URL="mongodb://user:pass@host:27017" npm run migrate
   node migrate.js /path/to/wrestling_bot.db --url "mongodb://user:pass@host:27017"

   # or from the previous MySQL database
   node migrate.js --from-mysql "mysql://user:pass@host:3306/railway" --url "mongodb://user:pass@host:27017"
   ```

The script copies the conversations and the memory string (including timestamps), and
fills in the `matches` and `key_facts` lists from it. It is safe to run multiple times —
chats that are already in a memory file are skipped, and anything the app has already
written to MongoDB is left untouched.

Reading the SQLite source needs Node >= 22.13 (uses the built-in `node:sqlite`) or the
`better-sqlite3` package; reading the MySQL source needs `mysql2`. Both are installed as
dev dependencies (`npm install`) and are only used by the migration.
