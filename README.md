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
- `RESEARCH_ENABLED` — master switch for opt-in web research on `POST /wrestling_chat`
  (default `true`). Research only ever runs when a request explicitly asks for it;
  set to `false` to disable it server-wide.
- `RESEARCH_AUTO_TRIGGER` — infer the request from the message text (default `false`).
  When a client can't be changed to send `research: true`, this makes a message that
  *asks* for a lookup ("research the two Atlantic ridge earthquakes", "look up …",
  "verify …") or asks a plainly time-sensitive question ("were there any M6+ quakes
  yesterday?", "what's the latest on …?") run one by itself. The heuristic is
  deliberately conservative and two-tier; ordinary conversation never triggers it.
  Leave it off in deployments where callers are untrusted — see the security note in
  the research section. Lookups started this way report `meta.research.trigger: "auto"`
  instead of `"explicit"`.
- `RESEARCH_NO_DATA_GUARD` — tell the model when no lookup ran (default `true`). Set to
  `false` to restore the previous prompt exactly. With the guard on, a message that
  reads like a request for current information ("research …", "the latest …",
  "in the last 24 hours") but that started no lookup gets one extra system message
  saying it has **no retrieved material** for this turn, that its training recall may be
  stale, and that it must cite nothing, must not narrate a search it didn't perform,
  must not report a negative result as verified, and must not offer to monitor or alert
  on future events. It calls nothing and costs nothing — which is the point, because
  the alternative is a chat model improvising exactly that answer with no failure
  anywhere for the caller to notice. Ordinary conversation is not affected (the same
  conservative detector as `RESEARCH_AUTO_TRIGGER` decides), and the notice explicitly
  leaves in-character conversation, opinions and roleplay unrestricted. It also forbids
  the compounding failure that conversations create on their own: earlier turns are
  replayed back to the model as history, so an unverified claim it made a few turns ago
  returns as apparent context and gets restated as established fact — an invented "5.8
  near the Azores" reappearing as "the biggest of the last 30 days", citation number
  attached. Both notices therefore state that earlier turns of the conversation are not
  a source either.
- `RESEARCH_KEYLESS_ENABLED` — enable the free, no-API-key providers (default `true`):
  general web search via the public DuckDuckGo / Bing results pages
  (`DUCKDUCKGO_WEB_API_URL` / `BING_WEB_API_URL`), then DuckDuckGo Instant Answers
  (`DUCKDUCKGO_API_URL`), Wikipedia (`WIKIPEDIA_API_URL`) and OpenAlex
  (`OPENALEX_API_URL`, plus optional `OPENALEX_MAILTO` for its polite pool — a
  contact email, not a key). With these on, research works with **no keys, no
  signup and no account**. Keyless results are best-effort (the results pages
  can rate-limit or bot-challenge, hence the fallback chain); the Instant
  Answers / Wikipedia / OpenAlex APIs alone are *not* general web search —
  Instant Answers only answers some queries, Wikipedia only returns Wikipedia
  articles and OpenAlex only papers — so they are last-resort fallbacks, not
  the primary providers. `RESEARCH_USER_AGENT` overrides the identifying
  header the API providers are sent (the results-page providers present a
  browser user agent unless this is set, as those endpoints refuse
  non-browser agents).
- `TAVILY_API_KEY` / `BRAVE_SEARCH_API_KEY` / `EXA_API_KEY` / `SERPER_API_KEY` — optional
  API key for a keyed web-search provider. None is required (see the keyless providers
  above); a configured keyed provider is tried *first* because its extracted full-text
  results are richer. `RESEARCH_PROVIDERS` sets the try-order (default
  `tavily,brave,exa,serper,duckduckgo_web,bing_web,duckduckgo,wikipedia,openalex`);
  on failure the next configured provider is tried. The matching `TAVILY_API_URL`,
  `BRAVE_SEARCH_API_URL`, `EXA_API_URL` and `SERPER_API_URL` variables override
  the provider endpoints (e.g. for a proxy).
- `RESEARCH_TIMEOUT_MS` — per-provider research timeout (default `5000`). Research adds
  at most roughly this much latency to a researched request.
- `RESEARCH_MAX_RESULTS` — default number of sources per research call (default `5`, max `10`).
- `RESEARCH_CONTEXT_CHAR_LIMIT` — how many characters of retrieved source text are sent
  to the model (default `6000`).
- `RESEARCH_MAX_TOKENS` — model reply token cap for researched requests only
  (default `800`; ordinary chat keeps the usual `250`).
- `RESEARCH_CACHE_TTL_MS` — how long identical research queries are served from an
  in-process cache (default `300000`; `0` disables caching).

On startup the server logs one line describing the research guards that are active —
`Research guards: enabled=… providers=[…] autoTrigger=… noDataGuard=… dateStamp=on
failureNotice=on citationAudit=on`. It carries provider *names*, never keys, and exists
so that "is this deployment running the research grounding fixes?" is answerable from
the logs instead of from a failing answer.
- `ANALYSIS_ENABLED` — master switch for Tier 2 data analysis on `POST /wrestling_chat`
  (default `true`). Analysis only runs when a request sends `analysis: true`.
- `WORLDBANK_API_URL` / `RESTCOUNTRIES_API_URL` — endpoint overrides for the two keyless
  structured-data providers (defaults `https://api.worldbank.org/v2` and
  `https://restcountries.com/v3.1`).
- `DATA_TIMEOUT_MS` — per-request timeout for structured-data providers (default `5000`).
- `DATA_CACHE_TTL_MS` — in-process cache for identical dataset specs (default `300000`;
  `0` disables caching).
- `ANALYSIS_MAX_ROWS` — maximum dataset rows analyzed per request (default `5000`).
- `ANALYSIS_CONTEXT_CHAR_LIMIT` — how many characters of computed analysis are sent to
  the model (default `6000`).
- `FORECAST_ENABLED` — master switch for Tier 3 predictive modeling on
  `POST /wrestling_chat` (default `true`; `PREDICTION_ENABLED` accepted). Only runs
  when a request sends `prediction: true`.
- `FORECAST_MIN_POINTS` — minimum usable series points before forecasting is refused
  as insufficient (default `5`).
- `FORECAST_DEFAULT_HORIZON` — future steps when no horizon is requested (default `5`).
- `FORECAST_MAX_HORIZON` — hard cap on requested horizon (default `50`; horizons whose
  span exceeds twice the observed span are still refused as irresponsible).
- `FORECAST_SIMULATIONS` — Monte Carlo draws per forecast point (default `1000`).
- `FORECAST_SEED` — PRNG seed making Monte Carlo results reproducible for identical
  requests (default `42`).
- `FORECAST_CONTEXT_CHAR_LIMIT` — characters of computed forecast sent to the model
  (default `6000`).

## Mistral API errors

Calls to Mistral go through `mistralClient.js`. Never `console.error` a raw axios error
object from these calls — it contains `config.headers.Authorization`, i.e. the raw API
key. Use `describeMistralError(error)`, which builds a short summary without any headers;
that is what the endpoints log and return in the `details` field of an error response.
Every response also includes an `X-Request-Id` header for correlation.

Run the tests with `npm test` (stubbed Mistral server, no real API key needed).

## Free response humanizer

`POST /ugcw_rp` is the same battle roleplay pipeline as `POST /wrestling_bot`, except it does **not** scale damage by height or weight. Self height and weight are still accepted and injected into the system prompt. Each fighter's state can be supplied either as a nested object (`self` / `opponent`, with `health`, `stamina`, `trapped`) or as flat fields (`self_health` / `self_stamina` / `self_trapped` and `opponent_health` / `opponent_stamina` / `opponent_trapped`). Anything omitted defaults to a fresh fighter (100 health, 100 stamina, not trapped). These states change move damage, the local humanizer (trapped skips phrase-dropping), and the move limiter (low health or being trapped caps outbound moves).

Both directions of a battle turn are resolved, and each one damages the *other* fighter:

- An attack found in the request `message` is dealt by `self` and damages `opponent` → `meta.opponent` plus `meta.damage.from_user`.
- An attack found in the generated AI reply is dealt by `opponent` and damages `self` → `meta.self` plus `meta.damage.from_ai`.

Each damage object contains `health`, `stamina`, and `bodyPart`, and is zeroed when that side did not attack (attacks in the AI reply are only resolved after generation, so narration alone never invents a hit). Feed `meta.self` and `meta.opponent` back in as the next request's `self` / `opponent` to carry the match forward. Memory for this endpoint is stored in a separate `_ugcw` folder pair.

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

## Opt-in web research (`POST /wrestling_chat`)

`POST /wrestling_chat` can research **any topic** on request — this is Tier 1 of the
research feature: live web search, retrieved sources injected into the model call, and
citations back to those sources. It is **strictly opt-in**: nothing changes for existing
callers, and no external API is called unless a single request explicitly asks for
research. **No API key, signup, or account is needed**: keyless providers are
enabled by default and work out of the box — general web search first (the public
DuckDuckGo and Bing results pages, `duckduckgo_web` / `bing_web`), with DuckDuckGo
Instant Answers, Wikipedia and OpenAlex as fallbacks. Those three APIs are not a
search engine on their own — Instant Answers returns nothing for most queries,
Wikipedia only has Wikipedia articles and OpenAlex only papers — which is why the
results-page providers lead the keyless chain. Configuring a keyed provider
(Tavily, Brave Search, Exa, or Serper) is optional and only upgrades result
quality — keyed providers are tried first, keyless ones are the always-available
fallback (see the `RESEARCH_*` environment variables above).

```js
await fetch(`${apiUrl}/wrestling_chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    user_id: userId,
    message: 'What is happening with EV battery costs?',
    research: true,                 // required — 'true' (form-encoded) also works
    // research_query: 'lithium pack price 2026',  // optional; defaults to `message`
    // research_max_results: 5,                    // optional; 1–10
    // research_provider: 'tavily'                 // optional; default = first configured
  })
});
```

What happens on a researched request:

1. Providers are queried in `RESEARCH_PROVIDERS` order (keyed providers with a
   configured key first, then the keyless DuckDuckGo web → Bing web → DuckDuckGo
   Instant Answers → Wikipedia → OpenAlex chain); on failure — or an empty
   result, which a no-match or bot-challenged results page produces — the next
   provider is tried. Use `research_provider: 'wikipedia'` (etc.) to pin one.
   Identical queries are cached in-process for `RESEARCH_CACHE_TTL_MS`.
2. The top results are normalized to `{ title, url, snippet }` and injected into the
   existing Mistral call as one extra system message, capped at
   `RESEARCH_CONTEXT_CHAR_LIMIT` characters. The model is instructed to answer from the
   sources and cite them as `[1]`, `[2]`, … — and, for that request only, not to claim
   it has no information access (the stock chat persona otherwise says exactly that).
   That block is also date-stamped in UTC ("Today is 2026-10-14 (UTC)") so relative
   time in the question ("yesterday", "the past 30 days") resolves against *now*
   rather than against the model's training cutoff, and citations are confined to the
   numbered list: the model may not mint a marker, an archive or an agency that the
   retrieved sources don't back, and may not narrate carrying out a search it didn't
   ("I combed through USGS, EMSC and NOAA" is exactly what this forbids).
3. The reply token cap is raised to `RESEARCH_MAX_TOKENS` for that call only. Ordinary
   requests keep the `250`-token default and the exact `{ response }` shape; a researched
   request additionally returns `meta.research`:

```jsonc
{
  "response": "…cited answer…",
  "meta": {
    "research": {
      "requested": true,
      "trigger": "explicit",        // "explicit" | "auto" (see RESEARCH_AUTO_TRIGGER)
      "status": "ok",               // "ok" | "unavailable" | "error"
      "provider": "tavily",
      "query": "What is happening with EV battery costs?",
      "cached": false,
      "sources": [{ "title": "…", "url": "https://…" }],
      "citations": {                // the reply's markers vs. the sources supplied
        "sources": 1,
        "used": [1],
        "invalid": [],              // markers pointing at a source that doesn't exist
        "uncited": false,           // sources were supplied and none were cited
        "stripped": []              // markers the server removed from the reply
      }
    }
  }
}
```

Failure is **fail-open**: if research is disabled, no provider is configured, the
requested provider is unknown, or every provider errors/times out, the request still
returns `200` with a normal chat reply and `meta.research.status` set to `"unavailable"`
or `"error"` (with a key-free error summary) instead of failing the chat.

Fail-open is not **fail-silent**, though. If the lookup was requested and returned
nothing, the model is still sent a system message — the failure notice — telling it the
lookup failed, that it has no retrieved material, that it must cite nothing, and that
it must not claim or imply it searched, checked or combed any archive, feed or agency,
nor state from memory whether a recent event did or didn't happen. Without that notice
an unanswered "research this" reaches a chat model that improvises a research-shaped
answer, complete with invented archive sweeps, invented negative results and invented
`[1]`/`[2]` markers — a wrong answer wearing the costume of a checked one. The reply
token cap is raised for the notice too (the honest answer needs the same room as a
sourced one). On such a turn `meta.research.citations.sources` is `0`, so any citation
marker in the reply is listed under `invalid` rather than shipped as if it pointed at
something.

The audit is a report; the **sanitizer** is the control. On any lookup-shaped turn the
reply is passed through `sanitizeFabricatedCitations()` before it is returned or stored:
a marker survives only if it names a source that was actually supplied this turn
(with sources `[1]`, a `[4]` is deleted; with no sources, every marker is deleted).
Returned text is what the caller sees, and the *stored* text is sanitized too — which is
what stops the compounding loop, because otherwise the next request replays the model's
own fabricated markers back to it as history. Replayed assistant turns additionally have
their markers stripped from the prompt copy (`stripCitationMarkers()`), so markers left
in history by older turns are not copied forward either; stored history itself is never
rewritten. The local humanizer leaves `[n]` markers untouched, so what the audit counts
is what the caller received, and `citations.stripped` lists what the sanitizer removed.

The research message — sources, or one of the two notices — is injected as the **last**
message, immediately before generation, rather than above the replayed history: it is the
constraint that matters most on such a turn, and instructions furthest from the point of
generation carry the least weight.

Research results are never written into the user's stored character facts, and no
provider API key ever appears in a response or log line.

The failure notice covers a lookup that **ran and returned nothing**. The commoner case
is that no lookup ran at all: research is opt-in, so a message like "research the two
Atlantic ridge earthquakes" — an explicit request to a human reader, an ordinary string
to this API — reaches the model with no sources and no instruction about sourcing
unless the client sends `research: true` or `RESEARCH_AUTO_TRIGGER` is on. That turn
gets the same treatment: `RESEARCH_NO_DATA_GUARD` (default `true`) injects a notice
telling the model it has no retrieved material, so it says so instead of inventing an
archive sweep, a negative result and citations. This is the only guard that is on by
default, because it makes no network call. Belt and braces: turn on
`RESEARCH_AUTO_TRIGGER` (or send `research: true`) so the lookup actually happens, and
leave `RESEARCH_NO_DATA_GUARD` on for the turns where it can't or doesn't.

Retrieved text is treated as **untrusted data**: it reaches the model inside a
`<research_data>` block with instructions to cite it, never to follow instructions
found inside it, and sources cannot forge the closing delimiter. The server never
fetches caller-supplied URLs, so the feature cannot be used as an SSRF proxy. Note
there is still no authentication on this endpoint — anyone who can call it can use
`research: true`, which with a keyed provider spends your quota (and with keyless
providers spends the operators' rate limits), so keep `RESEARCH_ENABLED=false` on
deployments where callers are not trusted. `RESEARCH_AUTO_TRIGGER` widens that surface
further (a message alone can start a lookup), so leave it off there too.

Predictive modeling/forecasting is deliberately *not* part of Tier 1 — that is
Tier 3. Tier 2 (next section) adds structured data and computed analysis.

## Opt-in data analysis (Tier 2, `POST /wrestling_chat`)

Tier 2 adds **structured datasets and deterministic local analysis**. It is opt-in
exactly like Tier 1: send `analysis: true` with a dataset, or nothing happens. All
providers are free with no API key. Crucially, **the model never does the math** —
`dataAnalysis.js` computes every number locally (means, medians, regression, …) and
the model only narrates the computed results it is handed.

Three dataset sources:

```js
// 1. World Bank time series (economy, population, health, … for any country)
{ user_id, message: 'How has Canada GDP trended?', analysis: true,
  dataset: { provider: 'worldbank', country: 'CAN', indicator: 'NY.GDP.MKTP.CD',
             start_year: 2000, end_year: 2023 } }        // country may be 'CAN;USA'

// 2. REST Countries reference data (compare/rank countries)
{ user_id, message: 'Compare these countries', analysis: true,
  dataset: { provider: 'restcountries', codes: 'CAN,USA,MEX' } }  // or name: / region:

// 3. Your own data — no network call at all (rows, or a JSON/CSV string in `data`)
{ user_id, message: 'Analyze my numbers', analysis: true,
  data: [{ month: 1, sales: 10 }, { month: 2, sales: 20 }],
  analysis_x: 'month', analysis_y: 'sales' }
```

Flat shorthand (`data_provider`, `country`, `indicator`, … at the top level) works in
place of the `dataset` object. Field selection: `analysis_x`, `analysis_y` (comma list
for a correlation), `analysis_group_by` — provider defaults apply otherwise (World Bank
uses `year`/`value`, REST Countries `population` by `region`).

What comes back, alongside the usual `response`:

```jsonc
"meta": { "analysis": {
  "requested": true, "status": "ok",       // "ok" | "unavailable" | "error"
  "dataset": { "provider": "worldbank", "description": "GDP … — World Bank", "rowCount": 24 },
  "summary": {
    "rowCount": 24,
    "columns": [ /* per-column: type, count, missing, unique, min/max/mean/median/q1/q3/stdDev */ ],
    "trend":  { "first": {}, "last": {}, "change": 0, "percentChange": 0, "slopePerUnit": 0, "rSquared": 0, "cagrPercent": 0,
                "series": [{ "x": 2000, "y": 0 }] },        // ≤100 sampled points, chart-ready
    "correlation": { "between": ["a", "b"], "pearsonR": 0, "strength": "strong" },  // when 2 y-fields
    "groups":  { "field": "region", "groups": [{ "group": "…", "mean": 0 }] },      // when grouping
    "outliers": { "field": "sales", "count": 1, "examples": [500] },                // IQR method
    "extremes": { "field": "sales", "min": {}, "max": {} }
  }
} }
```

The model receives the same numbers inside an `<analysis_data>` block (capped at
`ANALYSIS_CONTEXT_CHAR_LIMIT`), instructed to quote them exactly, never recalculate or
invent figures, and — unless a Tier 3 forecast was computed in the same request (it
arrives in its own block) — never present a forecast, as none was computed.
Fail-open rules match Tier 1: a provider outage, an invalid spec (rejected before any
network call — e.g. path-injection country codes), or a missing dataset returns `200`
with a normal reply and `meta.analysis.status` set accordingly. Research and analysis
compose in one request (`research: true, analysis: true` → both meta blocks).
Datasets and analysis results are never written into stored character facts.

## Opt-in predictive modeling (Tier 3, `POST /wrestling_chat`)

Tier 3 adds **forecasting** on top of a Tier 2 dataset. Send `prediction: true`
(alias `forecast: true`) with any Tier 2 dataset; the dataset is fetched once and
shared (a prediction implies the Tier 2 pipeline internally, but `meta.analysis`
only appears if `analysis: true` was also sent). All modeling is local and
deterministic — no ML service, no model-invented numbers:

```js
{ user_id, message: 'Where is Canada GDP heading?', prediction: true,
  dataset: { provider: 'worldbank', country: 'CAN', indicator: 'NY.GDP.MKTP.CD' },
  forecast_horizon: 5,          // future steps (default 5, cap FORECAST_MAX_HORIZON)
  // forecast_method: 'auto',   // 'linear' | 'log-linear' | 'holt' | 'drift'
  // forecast_at: 2030,         // add one specific future point
  // forecast_threshold: 3e12,  // → P(final point above this) from the simulation
  // forecast_simulations: 1000 // Monte Carlo draws per point
}
```

**Methods & selection.** Candidates — linear regression, log-linear (exponential
growth, needs all y > 0), Holt's trend smoothing, and drift — are **backtested** on
the series (fit on the early part, RMSE-scored on the held-out tail) and the winner
is refit on all data; `method: 'auto'` is the default. Each forecast point carries
the point estimate, analytic 80%/95% intervals, and seeded Monte Carlo
p10/p50/p90 quantiles (identical request + seed ⇒ identical result), plus a
confidence grade, the backtest table, warnings, and stated assumptions.

```jsonc
"meta": { "prediction": {
  "requested": true, "status": "ok",     // "ok" | "insufficient" | "unavailable" | "error"
  "dataset": { "provider": "worldbank", "description": "…", "rowCount": 24 },
  "forecast": {
    "method": "log-linear", "confidence": "high",
    "model": { "growthPercentPerUnit": 3.1 },
    "trainedOn": { "points": 24, "firstX": 2000, "lastX": 2023, "lastY": 2.9e12 },
    "points": [{ "x": 2024, "estimate": 3.0e12,
                 "intervals": { "80": { "lower": 0, "upper": 0 }, "95": { "lower": 0, "upper": 0 } },
                 "monteCarlo": { "p10": 0, "p50": 0, "p90": 0 } }],
    "threshold": { "value": 3e12, "atX": 2028, "probabilityAbove": 0.62 },  // if requested
    "warnings": [], "assumptions": [ "Univariate extrapolation: …" ]
  }
} }
```

The model receives these numbers in a `<forecast_data>` block, instructed to present
them as estimates with ranges — never certainties — and to state confidence and
assumptions.

**Refusal is a first-class outcome.** With too few points (< `FORECAST_MIN_POINTS`),
no non-constant numeric x axis, a horizon span more than twice the observed span,
or a backtest no better than the scale of the data itself, the answer is
`status: "insufficient"` with human-readable `reasons`, **no forecast numbers**, and
the model is instructed to explain the limitation instead of guessing. Duplicate x
values (e.g. a multi-country pull) are averaged into one series with a warning.
Dataset/provider failures fail open onto `meta.prediction` exactly like Tier 2.

Honest limits: this is univariate extrapolation of one numeric series. It models no
seasonality beyond trend, no causes, no covariates, no regime changes, and no
outside events — a trained ML or multi-series model remains future work, and would
plug into the same `forecasting.js` interface. Forecasts are statistical estimates,
not guarantees or betting/financial advice.

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
