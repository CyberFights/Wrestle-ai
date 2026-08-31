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
- `MODEL_MEMORY_CHAR_LIMIT` — how many characters of the most recent memory facts are sent to
  the model (default `6000`). Full memory remains stored in MongoDB.
- `MISTRAL_MODEL` — Mistral chat model to use (default `mistral-large-latest`).
- `MISTRAL_TIMEOUT_MS` — per-attempt timeout for Mistral API calls (default `30000`).
- `MISTRAL_MAX_RETRIES` — how many times a failed Mistral call is retried (default `3`).
  Retries only happen for transient failures — rate limits (429) and server errors
  (5xx, e.g. the 503 Mistral returns when overloaded), plus timeouts and connection
  errors — with exponential backoff. Permanent client errors (400/401/…) fail immediately.
- `REQUEST_BODY_LIMIT` — maximum HTTP request body size accepted by the API (default `1mb`).
- `RESPONSE_HUMANIZER_ENABLED` — enable the built-in, local response humanizer (default `true`).
  Set to `false` to return the model wording untouched by default; a request's `humanize`
  field can still override the server default for that response.

## Mistral API errors

Calls to Mistral go through `mistralClient.js`. Never `console.error` a raw axios error
object from these calls — it contains `config.headers.Authorization`, i.e. the raw API
key. Use `describeMistralError(error)`, which builds a short summary without any headers;
that is what the endpoints log and return in the `details` field of an error response.
Every response also includes an `X-Request-Id` header for correlation.

Run the tests with `npm test` (stubbed Mistral server, no real API key needed).

## Free response humanizer

Both `POST /wrestling_bot` and `POST /wrestling_chat` pass successful model text through a
small local humanizer by default. It is **free**: it has no external service, API key,
account, network request, or per-response charge. The humanizer only makes conservative
wording changes such as turning formal phrasing into contractions; it does not generate new
moves, alter the response order, or take control of the opponent. URLs and inline/fenced
code are preserved as-is.

To bypass it for one response, send `humanize: false` (or `humanize: 'false'` for a
form-encoded request). The `RESPONSE_HUMANIZER_ENABLED=false` environment variable changes
the default for all requests. On battle responses, humanization occurs before the existing
move/stamina sanitizer, so the existing `your turn.` and move-limit rules still apply.

## Troubleshooting common logs

### `Mistral API attempt 1 of 4 failed ... timeout of 30000ms exceeded`

The server successfully received the request, but Mistral did not answer within
`MISTRAL_TIMEOUT_MS` for that attempt. The client retries transient failures automatically.
If this happens often, try increasing `MISTRAL_TIMEOUT_MS`, switching `MISTRAL_MODEL` to a
faster model, or reducing how much `system_p`/memory text is sent with each request. The
server already caps model-visible memory with `MODEL_MEMORY_CHAR_LIMIT` so old accumulated
facts do not make every Mistral call grow forever.

### `Rejected malformed JSON: POST /wrestling_bot`

The request never reached the route or Mistral: Express rejected the HTTP body because it
was not valid JSON. To pinpoint the issue, server warnings and HTTP 400 responses include
a `snippet` preview showing the characters around the parse failure (with the offending
token highlighted).

Common causes include:
- **`Unexpected token y in JSON at position ...`**:
  - **Unescaped quotes in `system_p` or `message`**: hand-concatenating JSON strings when the
    text contains quotes (e.g. dialogue like `Jax says "your turn"` or `"you won't win"`)
    terminates the JSON string prematurely. The parser then encounters the raw word starting
    with `y` outside quotes.
  - **Unquoted booleans**: sending `"in_battle": yes` instead of `"in_battle": true` or
    `"in_battle": "yes"`. In JSON, only `true`, `false`, and `null` are recognized literal
    tokens; bare words like `yes` cause `Unexpected token y`.
  - **Unquoted string interpolation**: e.g. `"message": ${message}` or `"in_battle": ${inBattle}`
    where the variable starts with `y` or is unquoted.
- To avoid log floods, only the first few malformed JSON warnings per minute are printed
  in full; later ones are summarized.

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

Malformed request bodies receive a JSON `400` response with `error: "Invalid JSON body."`,
`snippet` (showing the offending snippet around the syntax failure), and a `request_id`
that also appears in the `X-Request-Id` response header and server logs.
The server does not guess how to repair invalid JSON, because arbitrary prompt text makes
that lossy and ambiguous.

If your client cannot safely produce JSON, send form-encoded fields instead. This avoids
having to escape quotes and newlines inside `message` or `system_p`:

```js
const body = new URLSearchParams({
  user_id: userId,
  message,
  system_p: systemPrompt,
  in_battle: 'true',
  stats: JSON.stringify(stats)
});

await fetch(`${apiUrl}/wrestling_bot`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body
});
```

## How memory is stored

The bot's memory lives in the MongoDB database (the "memory folder"). Inside it, **every
user gets TWO folder pairs of their own** — one pair per endpoint — so the wrestling
battle bot and the casual chat bot keep **separate** conversation histories. This is what
stops a `/wrestling_chat` reply from sounding like the `/wrestling_bot` battle persona
(and vice versa):

```
<database>/                      ← the memory folder
├── memory_r_12345_chats         ← chat messages via POST /wrestling_chat
├── memory_r_12345_facts         ← character facts via POST /wrestling_chat
├── memory_r_12345_chats_battle  ← chat messages via POST /wrestling_bot
├── memory_r_12345_facts_battle  ← character facts via POST /wrestling_bot
├── memory_r_67890_chats
├── memory_r_67890_facts
└── …
```

Folder names are derived from the user id (`memory_r_<user_id>` for ids made of letters,
digits, `-` and `_`; `memory_b_<base64url>` or `memory_h_<sha256>` for anything else), with
`_chats` / `_facts` (chat scope) or `_chats_battle` / `_facts_battle` (battle scope)
appended to pick the folder, so they are always unique per user and always valid in
MongoDB. A new user's folders are created automatically the first time anything is stored
or read for them.

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
is split into the **battle-scoped** folder pair automatically (the wrestling battle bot is
the original product, so the un-scoped legacy history belongs to it; the casual chat bot
starts with a clean slate). This is idempotent and never deletes the originals, so
restarting never duplicates anything and upgrading never loses data. Once you are happy
everything moved over, you can drop those old collections by hand.

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
