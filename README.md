# Wrestle-ai

Custom Mistral-powered wrestling roleplay AI server.

Uses a **MySQL** database (via `mysql2`) — designed to run on [Railway](https://railway.app) with its MySQL plugin.

## Environment variables

- `MYSQL_URL` — MySQL connection string, e.g. `mysql://user:password@host:3306/railway`.
  Railway sets this automatically when a MySQL plugin is attached. `DATABASE_URL` is accepted as a fallback.
- `MISTRAL_API_KEY` — Mistral AI API key.
- `PORT` — port to listen on (default `8080`).

On startup the server creates the `conversations` and `memory` tables automatically.

## Migrating your old SQLite history

If you used the old SQLite version of this bot (`wrestling_bot.db`), you can copy its
history into the MySQL database with the included migration script:

1. Make sure your old `wrestling_bot.db` is on the machine you're running the command from.
2. Get your Railway MySQL URL — on the Railway dashboard, open your service →
   **Variables** tab → copy the `MYSQL_URL` value.
3. Run the migration (from this folder):

   ```bash
   npm install
   MYSQL_URL="mysql://user:pass@host:3306/railway" npm run migrate
   # or, if the database file is somewhere else:
   node migrate.js /path/to/wrestling_bot.db --url "mysql://user:pass@host:3306/railway"
   ```

The script copies both `conversations` and `memory` (including timestamps) and is
safe to run multiple times — rows that are already in MySQL are skipped, and any
data the app already wrote to MySQL is left untouched.

It needs Node >= 22.13 (uses the built-in `node:sqlite`) or the `better-sqlite3`
package (installed automatically as a dev dependency).

