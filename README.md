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
- `MEMORY_CHAT_LIMIT` — how many chats each chats file keeps (default `2000`).
- `MEMORY_FACT_LIMIT` — how many matches / key facts each facts file keeps (default `500`).
- `MODEL_HISTORY_LIMIT` — how many of the most recent chats are sent to the model (default `10`).
  Only stored history is affected by `MEMORY_CHAT_LIMIT`; the model never sees more than this.
- `MISTRAL_TIMEOUT_MS` — per-attempt timeout for Mistral API calls (default `30000`).
- `MISTRAL_MAX_RETRIES` — how many times a failed Mistral call is retried (default `3`).
  Retries only happen for transient failures — rate limits (429) and server errors
  (5xx, e.g. the 503 Mistral returns when overloaded), plus timeouts and connection
  errors — with exponential backoff. Permanent client errors (400/401/…) fail immediately.

## Mistral API errors

Calls to Mistral go through `mistralClient.js`. Never `console.error` a raw axios error
object from these calls — it contains `config.headers.Authorization`, i.e. the raw API
key. Use `describeMistralError(error)`, which builds a short summary without any headers;
that is what the endpoints log and return in the `details` field of an error response.

Run the tests with `npm test` (stubbed Mistral server, no real API key needed).

## Sending requests

Always let a JSON serializer encode the **complete** request object. In particular, do not
interpolate `message` or `system_p` into a hand-built JSON string: prompts commonly contain
quotes and newlines, which make that string invalid and cause `Unexpected token ... in JSON`
errors before the request reaches either route.

```js
await fetch(`${apiUrl}/wrestling_bot`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    user_id: userId,
    message,
    system_p: systemPrompt,
    in_battle: true,
    stats
  })
});
```

Malformed request bodies receive a JSON `400` response with `error: "Invalid JSON body."`.
The server does not guess how to repair invalid JSON, because arbitrary prompt text makes
that lossy and ambiguous.

## How memory is stored

The bot's memory lives in the MongoDB database (the "memory folder"). Inside it, **every
user gets TWO folders of their own** — two MongoDB collections — one for chat messages
and one for character facts:

```
<database>/                ← the memory folder
├── memory_r_12345_chats   ← one user's chat messages folder
├── memory_r_12345_facts   ← the same user's character facts folder
├── memory_r_67890_chats   ← another user's chat messages folder
├── memory_r_67890_facts   ← another user's character facts folder
└── …
```

Folder names are derived from the user id (`memory_r_<user_id>` for ids made of letters,
digits, `-` and `_`; `memory_b_<base64url>` or `memory_h_<sha256>` for anything else), with
`_chats` / `_facts` appended to pick the folder, so they are always unique per user and
always valid in MongoDB. A new user's folders are created automatically the first time
anything is stored or read for them.

Each folder holds **one memory file** — a single document keyed by the user id:

```jsonc
// <base>_chats — the chat messages folder
{
  "_id": "<user_id>",
  "user_id": "<user_id>",
  "chats": [ { "role": "user", "message": "…", "timestamp": "…" } ],  // conversation history
  "created_at": "…",
  "updated_at": "…"
}

// <base>_facts — the character facts folder
{
  "_id": "<user_id>",
  "user_id": "<user_id>",
  "character_facts": "…",   // the memory string sent to the model
  "matches":   [ { "text": "…", "timestamp": "…" } ],  // matches that came up
  "key_facts": [ { "text": "…", "timestamp": "…" } ],  // notable events / facts
  "created_at": "…",
  "updated_at": "…"
}
```

Folders and their indexes are created automatically. Because a MongoDB document maxes out
at 16 MB, the chats file keeps the most recent `MEMORY_CHAT_LIMIT` chats and the facts
file the most recent `MEMORY_FACT_LIMIT` matches / key facts. Only the **10 most recent
chats** (`MODEL_HISTORY_LIMIT`) are ever sent to the model, no matter how many are stored.

On startup, any data still stored in an older layout — the old flat `memory` collection or
the previous single-folder layout (one folder per user holding chats and facts together) —
is split into the two folders automatically. This is idempotent and never deletes the
originals, so restarting never duplicates anything and upgrading never loses data. Once you
are happy everything moved over, you can drop those old collections by hand.

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
