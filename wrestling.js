const crypto = require('crypto');
const express = require('express');
const bodyParser = require('body-parser');
const { sanitizeMoveOutput } = require('./moveSanitizer');
const { humanizeResponse } = require('./humanizer');
const { createMistralClient, describeMistralError } = require('./mistralClient');
const { createResearchClient, formatResearchContext, formatResearchFailureNotice, formatNoLiveDataNotice, auditCitations, sanitizeFabricatedCitations, stripCitationMarkers, detectResearchIntent, describeResearchError } = require('./research');
const {
  createDataClient,
  analyzeDataset,
  formatAnalysisContext,
  describeDataError
} = require('./dataAnalysis');
const {
  createForecaster,
  formatForecastContext,
  formatForecastRefusalContext
} = require('./forecasting');
const { CHAT_SCOPE, BATTLE_SCOPE, UGCW_SCOPE } = require('./memoryFolders');
const {
  initDb,
  storeMessage,
  getLastMessages,
  getCharacterFacts,
  updateCharacterFacts,
  MODEL_HISTORY_LIMIT
} = require('./memoryStore');

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
if (!MISTRAL_API_KEY) throw new Error('MISTRAL_API_KEY env variable not set');

// Wraps the Mistral API with a timeout, retries on transient failures
// (429/5xx — e.g. the 503s Mistral returns when overloaded), and leak-safe
// error descriptions. IMPORTANT: never log a raw axios error object — it
// contains config.headers.Authorization, i.e. the API key.
const mistral = createMistralClient({ apiKey: MISTRAL_API_KEY });

// Opt-in web research for /wrestling_chat (see research.js). Inert until a
// request explicitly asks for it: creating the client never calls the
// network, and ordinary chats never touch it. Keyless providers
// (DuckDuckGo / Wikipedia / OpenAlex) make it work with no API key at all.
const researchClient = createResearchClient();
const RESEARCH_MAX_TOKENS = parsePositiveInt(process.env.RESEARCH_MAX_TOKENS, 800);
// Optional heuristic triggering. The endpoint's contract is strict opt-in:
// only the request's `research` field starts a lookup. But "research the two
// Atlantic ridge earthquakes" typed into a chat box is an explicit request to
// a human reader and an ordinary string to the API, so with this on, a message
// that asks for a lookup (or asks a plainly time-sensitive question) turns
// research on by itself. Off by default — no deployment gets surprise network
// calls or surprise provider costs unless it asks for them.
const RESEARCH_AUTO_TRIGGER = parseOptionalBoolean(process.env.RESEARCH_AUTO_TRIGGER, false);
// The no-lookup counterpart, on by default because it costs nothing: when a
// message reads like a request for current information and no lookup ran, the
// model is told it has no retrieved material — instead of being left to
// improvise a research-shaped answer from memory. See formatNoLiveDataNotice.
const RESEARCH_NO_DATA_GUARD = parseOptionalBoolean(process.env.RESEARCH_NO_DATA_GUARD, true);

// Opt-in Tier 2 data analysis for /wrestling_chat (see dataAnalysis.js):
// structured datasets (World Bank / REST Countries / caller-supplied rows)
// analyzed locally and deterministically. Equally inert until requested —
// creating the client never calls the network.
const dataClient = createDataClient();

// Opt-in Tier 3 predictive modeling for /wrestling_chat (see forecasting.js):
// local, deterministic forecasting over a Tier 2 dataset's series. Inert
// until requested; creating it never calls the network (it has no I/O).
const forecaster = createForecaster();

const app = express();

const BODY_LIMIT = process.env.REQUEST_BODY_LIMIT || '1mb';
const MODEL_MEMORY_CHAR_LIMIT = parsePositiveInt(process.env.MODEL_MEMORY_CHAR_LIMIT, 6000);
const MALFORMED_JSON_LOG_WINDOW_MS = 60 * 1000;
const MALFORMED_JSON_LOG_LIMIT = 5;
const malformedJsonLogState = {
  windowStart: Date.now(),
  emitted: 0,
  suppressed: 0
};

function newRequestId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function sanitizeLogValue(value, maxLength = 160) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, maxLength);
}

function parsePositiveInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function extractErrorSnippet(body, error) {
  if (!body) return null;
  const raw = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
  if (!raw.length) return null;

  let position = -1;
  const posMatch = error?.message?.match(/position\s+(\d+)/i);
  if (posMatch) {
    position = parseInt(posMatch[1], 10);
  } else {
    const lineColMatch = error?.message?.match(/line\s+(\d+)\s+column\s+(\d+)/i);
    if (lineColMatch) {
      const line = parseInt(lineColMatch[1], 10);
      const col = parseInt(lineColMatch[2], 10);
      const lines = raw.split('\n');
      if (line >= 1 && line <= lines.length) {
        let p = 0;
        for (let i = 0; i < line - 1; i++) {
          p += lines[i].length + 1;
        }
        position = p + (col - 1);
      }
    }
  }

  if (Number.isFinite(position) && position >= 0 && position <= raw.length) {
    const start = Math.max(0, position - 25);
    const end = Math.min(raw.length, position + 25);
    const before = sanitizeLogValue(raw.slice(start, position), 30);
    const at = sanitizeLogValue(raw.slice(position, position + 1), 5) || '?';
    const after = sanitizeLogValue(raw.slice(position + 1, end), 30);
    return `${start > 0 ? '...' : ''}${before}[${at}]${after}${end < raw.length ? '...' : ''}`;
  }

  const excerptMatch = error?.message?.match(/is not valid JSON/i) &&
    error?.message?.match(/Unexpected token\s+[^,]+,\s*(.*?)\s*is not valid JSON/i);
  if (excerptMatch && excerptMatch[1]) {
    return sanitizeLogValue(excerptMatch[1], 80);
  }

  return sanitizeLogValue(raw.slice(0, 60), 60) + (raw.length > 60 ? '...' : '');
}

function logMalformedJson(req, error, snippet) {
  const now = Date.now();
  if (now - malformedJsonLogState.windowStart > MALFORMED_JSON_LOG_WINDOW_MS) {
    if (malformedJsonLogState.suppressed > 0) {
      console.warn(
        `Suppressed ${malformedJsonLogState.suppressed} additional malformed JSON request(s) ` +
        `in the previous ${MALFORMED_JSON_LOG_WINDOW_MS / 1000}s window.`
      );
    }
    malformedJsonLogState.windowStart = now;
    malformedJsonLogState.emitted = 0;
    malformedJsonLogState.suppressed = 0;
  }

  const bodyBytes = Buffer.isBuffer(error?.body)
    ? error.body.length
    : Buffer.byteLength(error?.body || '');
  const context =
    `request_id=${req.requestId} ip=${clientIp(req)} ` +
    `content_type=${sanitizeLogValue(req.headers['content-type'] || 'none', 80)} ` +
    `bytes=${bodyBytes || sanitizeLogValue(req.headers['content-length'] || 'unknown', 24)} ` +
    `reason=${sanitizeLogValue(error?.message || 'parse failed')}` +
    (snippet ? ` snippet=${JSON.stringify(snippet)}` : '');

  if (malformedJsonLogState.emitted < MALFORMED_JSON_LOG_LIMIT) {
    console.warn(`Rejected malformed JSON: ${req.method} ${req.originalUrl} (${context})`);
    malformedJsonLogState.emitted += 1;
    return;
  }

  malformedJsonLogState.suppressed += 1;
  if (malformedJsonLogState.suppressed === 1) {
    console.warn(
      `Rejected malformed JSON: ${req.method} ${req.originalUrl} ` +
      `(further duplicate warnings suppressed for ${MALFORMED_JSON_LOG_WINDOW_MS / 1000}s; last ${context})`
    );
  }
}

app.use((req, res, next) => {
  const incomingId = req.headers['x-request-id'];
  req.requestId = typeof incomingId === 'string' && incomingId.trim()
    ? incomingId.trim().slice(0, 128)
    : newRequestId();
  res.setHeader('X-Request-Id', req.requestId);
  next();
});

app.use(bodyParser.json({ limit: BODY_LIMIT }));
app.use(bodyParser.urlencoded({ extended: true, limit: BODY_LIMIT }));

// body-parser forwards invalid JSON to Express as an error before a route is
// reached. Without an error handler Express's default handler prints the full
// SyntaxError stack for every bad request, which both floods production logs
// and gives API callers an HTML response. Keep malformed client payloads as a
// normal 400 response instead. We deliberately do not try to "repair" the
// body: arbitrary prompt/message text makes that ambiguous and unsafe. Callers
// must serialize request objects with JSON.stringify (or their HTTP library's
// `json` option), rather than interpolating text into a JSON string.
app.use((error, req, res, next) => {
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Request body too large.',
      details: `The request body exceeded the configured limit (${BODY_LIMIT}).`,
      request_id: req.requestId
    });
  }

  if (error?.type !== 'entity.parse.failed') return next(error);

  const snippet = extractErrorSnippet(error?.body, error);
  logMalformedJson(req, error, snippet);
  return res.status(400).json({
    error: 'Invalid JSON body.',
    details: 'Serialize the complete request object as JSON; do not concatenate message or system_p text into JSON. If your client cannot JSON-encode safely, send application/x-www-form-urlencoded fields instead.',
    request_id: req.requestId,
    ...(snippet ? { snippet } : {})
  });
});

app.use((req, res, next) => {
  if (req.body == null) req.body = {};
  next();
});

// ---------- DAMAGE ENGINE HELPERS ----------

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function parseMove(message, previousTarget) {
  const m = message.toLowerCase();

  // Only treat as a move if it contains a clear attack verb
  const ATTACK_VERBS = /(punch|jab|elbow|forearm|chop|kick|knee|stomp|slam|suplex|powerbomb|driver|throw|choke|lock|hold|stretch|crank|wrench|strike)/;
  if (!ATTACK_VERBS.test(m)) {
    return { moveType: 'none', target: 'none', repeated: false };
  }

  let moveType = 'strike';
  if (/(slam|suplex|powerbomb|driver|throw)/.test(m)) moveType = 'slam';
  if (/(choke|lock|hold|stretch|crank|wrench)/.test(m)) moveType = 'submission';

  let target = 'none';
  if (/(head|jaw|face|skull|chin)/.test(m)) target = 'head';
  else if (/(ribs|chest|torso|body|abs|back)/.test(m)) target = 'ribs';
  else if (/(arm|shoulder|wrist|elbow|hand)/.test(m)) target = 'arms';
  else if (/(leg|knee|thigh|ankle|foot)/.test(m)) target = 'legs';

  const repeated = previousTarget && target !== 'none' && target === previousTarget;

  return { moveType, target, repeated };
}


function getBaseDamage(moveType) {
  switch (moveType) {
    case 'strike':
      return { health: 5, stamina: 4, bodyPart: 8 };
    case 'slam':
      return { health: 12, stamina: 8, bodyPart: 15 };
    case 'submission':
      return { health: 4, stamina: 12, bodyPart: 18 };
    default:
      return { health: 0, stamina: 0, bodyPart: 0 };
  }
}

function applyScaling(baseDamage, heightInches, weightLbs) {
  let mult = 1;

  // weight class
  if (weightLbs < 150) mult *= 1.1;
  else if (weightLbs >= 220 && weightLbs <= 300) mult *= 0.9;
  else if (weightLbs > 300) mult *= 0.8;

  // height leverage
  if (heightInches < 68) mult *= 0.9;
  else if (heightInches > 74) mult *= 1.1;

  return {
    health: baseDamage.health * mult,
    stamina: baseDamage.stamina * mult,
    bodyPart: baseDamage.bodyPart * mult
  };
}

function applyRepeatedTargeting(damage, repeatedCount) {
  let mult = 1;
  if (repeatedCount === 2) mult = 1.25;
  else if (repeatedCount === 3) mult = 1.4;
  else if (repeatedCount >= 4) mult = 1.6;

  return {
    health: damage.health * mult,
    stamina: damage.stamina * mult,
    bodyPart: damage.bodyPart * mult
  };
}

function applyHealthTrappedInfluence(damage, selfState, opponentState) {
  let mult = 1;

  if (selfState.health < 50) mult *= 0.9;
  if (selfState.health < 25) mult *= 0.85;
  if (selfState.trapped) mult *= 0.65;

  if (opponentState.health < 50) mult *= 1.1;
  if (opponentState.health < 25) mult *= 1.15;
  if (opponentState.trapped) mult *= 1.25;

  return {
    health: damage.health * mult,
    stamina: damage.stamina,
    bodyPart: damage.bodyPart * mult
  };
}

function formatUgcwState(selfState, opponentState, heightInches, weightLbs) {
  return (
    `Self (you):\n` +
    `Height: ${heightInches} in\n` +
    `Weight: ${weightLbs} lbs\n` +
    `Health: ${clamp(selfState.health)}%\n` +
    `Stamina: ${clamp(selfState.stamina)}%\n` +
    `Trapped: ${selfState.trapped ? 'yes' : 'no'}\n` +
    `Opponent:\n` +
    `Health: ${clamp(opponentState.health)}%\n` +
    `Stamina: ${clamp(opponentState.stamina)}%\n` +
    `Trapped: ${opponentState.trapped ? 'yes' : 'no'}`
  );
}

function applyStaminaInfluence(damage, currentStamina) {
  let mult = 1;
  if (currentStamina < 50) mult *= 1.1;
  if (currentStamina < 25) mult *= 1.2;

  return {
    health: damage.health * mult,
    stamina: damage.stamina, // stamina drain stays as is
    bodyPart: damage.bodyPart * mult
  };
}

function applyDamage(stats, damage, target) {
  const updated = { ...stats };

  updated.health = clamp(stats.health - damage.health);
  updated.stamina = clamp(stats.stamina - damage.stamina);

  if (target === 'head') updated.head = clamp(stats.head + damage.bodyPart);
  if (target === 'ribs') updated.ribs = clamp(stats.ribs + damage.bodyPart);
  if (target === 'arms') updated.arms = clamp(stats.arms + damage.bodyPart);
  if (target === 'legs') updated.legs = clamp(stats.legs + damage.bodyPart);

  return updated;
}

function formatDamageState(stats) {
  return (
    `Current Damage State:\n` +
    `Health: ${clamp(stats.health)}%\n` +
    `Stamina: ${clamp(stats.stamina)}%\n` +
    `Head Damage: ${clamp(stats.head)}%\n` +
    `Rib Damage: ${clamp(stats.ribs)}%\n` +
    `Arm Damage: ${clamp(stats.arms)}%\n` +
    `Leg Damage: ${clamp(stats.legs)}%`
  );
}

function asString(value) {
  return value == null ? '' : String(value);
}

function parseNumber(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return false;
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  }
  return Boolean(value);
}

// The local humanizer is on by default. An explicit request value wins over
// the server setting so API clients can preserve raw model wording when they
// need it (for example, when rendering a quoted transcript).
function parseOptionalBoolean(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string' && !value.trim()) return fallback;
  if (typeof value === 'boolean' || typeof value === 'number') return parseBoolean(value);
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function shouldHumanizeResponse(requestValue) {
  const configured = parseOptionalBoolean(process.env.RESPONSE_HUMANIZER_ENABLED, true);
  return parseOptionalBoolean(requestValue, configured);
}

function parseObject(value, fallback = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (err) {
      // Leave malformed optional nested fields at their fallback. The outer body
      // parser already rejects malformed top-level JSON.
    }
  }
  return fallback;
}

function normalizeStats(stats) {
  const parsed = parseObject(stats);
  return {
    health: parseNumber(parsed.health, 100),
    stamina: parseNumber(parsed.stamina, 100),
    head: parseNumber(parsed.head, 0),
    ribs: parseNumber(parsed.ribs, 0),
    arms: parseNumber(parsed.arms, 0),
    legs: parseNumber(parsed.legs, 0)
  };
}

function normalizeFighterState(value, fallbacks = {}) {
  const parsed = parseObject(value);
  return {
    health: parseNumber(parsed.health != null ? parsed.health : fallbacks.health, 100),
    stamina: parseNumber(parsed.stamina != null ? parsed.stamina : fallbacks.stamina, 100),
    trapped: parseBoolean(parsed.trapped != null ? parsed.trapped : fallbacks.trapped)
  };
}

function normalizeTarget(value) {
  const target = asString(value).trim().toLowerCase();
  if (!target || ['null', 'undefined', 'none'].includes(target)) return null;
  return target;
}

function memoryForModel(characterFacts) {
  const facts = asString(characterFacts).trim();
  if (!facts) return '';
  if (facts.length <= MODEL_MEMORY_CHAR_LIMIT) return facts;

  return (
    '[Earlier memory omitted to keep the Mistral request responsive; showing most recent memory.]\n' +
    facts.slice(-MODEL_MEMORY_CHAR_LIMIT)
  );
}

// Tier 2 dataset spec resolution. Three caller shapes, most explicit first:
//   dataset: { provider: 'worldbank', country: 'CAN', indicator: '…' }  (or
//            { provider: 'restcountries', code: 'CAN' }, or { rows: [...] },
//            or a JSON string of any of those)
//   data:    [...] / { rows: [...] } / JSON-or-CSV string  (inline rows)
//   flat:    data_provider + country/indicator/… fields
// Returns null when the request carries no dataset at all.
function buildDatasetSpec(body) {
  if (Array.isArray(body.dataset)) return { provider: 'inline', rows: body.dataset };
  const dataset = parseObject(body.dataset);
  if (Object.keys(dataset).length) return dataset;
  if (body.data != null) return { provider: 'inline', data: body.data };

  const flat = {};
  const fields = ['country', 'countries', 'indicator', 'start_year', 'end_year', 'region', 'code', 'codes', 'name'];
  if (body.data_provider != null) flat.provider = body.data_provider;
  for (const field of fields) {
    if (body[field] != null) flat[field] = body[field];
  }
  return Object.keys(flat).length ? flat : null;
}

// Explicit request fields (analysis_x / analysis_y / analysis_group_by or
// x/y/groupBy inside the dataset object) win over provider defaults such as
// World Bank's year/value.
function analysisOptionsFor(body, defaults = {}) {
  const dataset = parseObject(body.dataset);
  return {
    x: asString(body.analysis_x).trim() || dataset.x || defaults.x,
    y: body.analysis_y ?? dataset.y ?? defaults.y,
    groupBy: asString(body.analysis_group_by).trim() || dataset.groupBy || dataset.group_by || defaults.groupBy
  };
}

// Tier 3 forecast options. x/y come from the Tier 2 analysis selection so
// the forecast always models exactly the series that was analyzed; the
// forecast_* request fields (prediction_* accepted as aliases) tune the rest.
function forecastOptionsFor(body, selection = {}) {
  return {
    x: selection.x,
    y: Array.isArray(selection.y) ? selection.y[0] : selection.y,
    horizon: parseNumber(body.forecast_horizon ?? body.prediction_horizon, undefined),
    at: parseNumber(body.forecast_at ?? body.prediction_at, undefined),
    method: asString(body.forecast_method || body.prediction_method).trim().toLowerCase() || undefined,
    threshold: parseNumber(body.forecast_threshold ?? body.prediction_threshold, undefined),
    simulations: parseNumber(body.forecast_simulations, undefined)
  };
}

// ---------- ROUTES ----------

app.get('/', (req, res) => {
  return res.status(500).json({
    error: 'this is a private Ai interface not meant for public use, without the correct key you cannot use it, your ipaddress has been logged'
  });
});

app.post('/wrestling_bot', async (req, res) => {
  const {
    user_id,
    message,
    system_p,
    in_battle,
    height,
    weight,
    stats,
    previous_target,
    repeated_count,
    humanize
  } = req.body;

  const userId = asString(user_id);
  const userMessage = asString(message);
  const systemPrompt = asString(system_p);
  const humanizeReply = shouldHumanizeResponse(humanize);

  if (!userId || !userMessage) {
    return res.status(400).json({ error: 'Missing user_id or message.' });
  }

  const inBattle = parseBoolean(in_battle);
  const heightInches = parseNumber(height, 72);
  const weightLbs = parseNumber(weight, 210);
  const previousTarget = normalizeTarget(previous_target);
  const repeatedCount = Math.max(0, Math.floor(parseNumber(repeated_count, 0)));
  const safeStats = normalizeStats(stats);

  let updatedStats = { ...safeStats };
  let newTarget = previousTarget;
  let newRepeatedCount = repeatedCount;

  if (inBattle) {
    const parsed = parseMove(userMessage, previousTarget);

    if (parsed.moveType !== 'none') {
      const base = getBaseDamage(parsed.moveType);
      let dmg = applyScaling(base, heightInches, weightLbs);

      if (parsed.target && parsed.target !== 'none') {
        if (parsed.target === previousTarget) {
          newRepeatedCount = (repeatedCount || 1) + 1;
        } else {
          newRepeatedCount = 1;
        }
        dmg = applyRepeatedTargeting(dmg, newRepeatedCount);
        newTarget = parsed.target;
      }

      dmg = applyStaminaInfluence(dmg, safeStats.stamina);
      updatedStats = applyDamage(safeStats, dmg, parsed.target);
    }
  }

  const damageStateText = inBattle ? formatDamageState(updatedStats) : '';

  const baseSystemPrompt = systemPrompt && systemPrompt.trim().length
    ? systemPrompt
    : `You are Jax Nova — a high-energy, charismatic, slightly sarcastic male pro-wrestling persona.
Always speak in first person, describing your sensations, reactions, and internal thoughts.
Never break character. 
Roleplay Structure:
- The user controls the opponent.
- You control only yourself (Jax Nova).
- You never decide, describe, or predict the opponent’s actions, choices, or outcomes.
Opponent Move Detection:
- Only treat the user’s message as an ATTACK if it contains a clear attack verb:
  (punch, jab, elbow, forearm, chop, kick, knee, stomp, slam, suplex, powerbomb,
   driver, throw, choke, lock, hold, stretch, crank, wrench, strike).
- If the user describes movement, posing, reactions, emotions, taunts, or positioning
  WITHOUT an attack verb, treat it as NON-DAMAGING. React emotionally or verbally,
  but do NOT behave as if you were physically hit.
- If the user describes dialogue or internal thoughts, treat it as NON-DAMAGING.
Control Rules:
- You do NOT invent attacks, counters, reversals, or strategies for the opponent.
- You do NOT move the opponent’s body unless the user already described it.
- You do NOT assume the opponent’s next move, mindset, or plan.
Response Format (every turn):
1. React to the opponent’s last action (attack or non-attack) based ONLY on what the user wrote.
2. Describe your next move attempt (up to two moves, depending on stamina).
3. End every turn with: "your turn."
Tone & Style:
Energetic first-person mix of internal thoughts + physical action. Emphasize impact, struggle,
and momentum shifts.`;

  // The damage state is appended during battle even when the caller supplied a
  // custom system_p, so the model always narrates from the opponent's current
  // health / stamina / damage rather than a stale or missing snapshot.
  const SYSTEM_PROMPT = inBattle
    ? `${baseSystemPrompt}\n${damageStateText}`
    : baseSystemPrompt;

  // Store user message immediately (same as wrestling_chat), scoped to the
  // battle endpoint so it never leaks into casual chat.
  try {
    await storeMessage(userId, userMessage, 'user', BATTLE_SCOPE);
  } catch (error) {
    return res.status(500).json({ error: 'Database error', details: error.message });
  }

  // Load conversation history + memory.
  // Only the 10 most recent messages (MODEL_HISTORY_LIMIT) are sent to the
  // model — and since storeMessage() above already saved the current message,
  // the history ends with it: do NOT append `message` again here.
  const chatHistory = await getLastMessages(userId, MODEL_HISTORY_LIMIT, BATTLE_SCOPE);
  const characterFacts = await getCharacterFacts(userId, BATTLE_SCOPE);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT }
  ];

  const modelMemory = memoryForModel(characterFacts);
  if (modelMemory) {
    messages.push({ role: 'system', content: `Memory: ${modelMemory}` });
  }

  chatHistory.forEach(msg => messages.push({ role: msg.role, content: msg.content }));
  try {
    const rawReply = await mistral.chat(messages);
    // Humanize before the move sanitizer so the existing stamina / ending rules
    // remain authoritative for battle responses.
    const humanizedReply = humanizeReply ? humanizeResponse(rawReply) : rawReply;
    const botReply = sanitizeMoveOutput(humanizedReply, updatedStats.stamina);

    // Store assistant reply (battle scope)
    await storeMessage(userId, botReply, 'assistant', BATTLE_SCOPE);

    let updatedFacts = characterFacts;

    if (userMessage.toLowerCase().includes('match')) {
      updatedFacts += ` | New match discussed: ${userMessage}`;
    }

    if (userMessage.toLowerCase().match(/slam|cyclone|roar|injur|pain|nsfw|sex|fuck|kiss|touch/)) {
      updatedFacts += ` | Notable event: ${userMessage}`;
    }

    if (updatedFacts && updatedFacts !== characterFacts) {
      await updateCharacterFacts(userId, updatedFacts, BATTLE_SCOPE);
    }

    res.json({
      response: botReply,
      updated_stats: updatedStats,
      meta: {
        target: newTarget,
        repeated_count: newRepeatedCount
      }
    });
  } catch (error) {
    // describeMistralError never includes headers — safe to log/respond with.
    const details = describeMistralError(error);
    console.error(`Mistral API request failed: ${details}`);
    res.status(500).json({
      error: 'Mistral API error',
      details
    });
  }
});

app.post('/ugcw_rp', async (req, res) => {
  const {
    user_id,
    message,
    system_p,
    in_battle,
    height,
    weight,
    humanize,
    self: selfFighter,
    opponent,
    self_health,
    self_stamina,
    self_trapped,
    opponent_health,
    opponent_stamina,
    opponent_trapped
  } = req.body;

  const userId = asString(user_id);
  const userMessage = asString(message);
  const systemPrompt = asString(system_p);
  const humanizeReply = shouldHumanizeResponse(humanize);

  if (!userId || !userMessage) {
    return res.status(400).json({ error: 'Missing user_id or message.' });
  }

  const inBattle = parseBoolean(in_battle);
  const heightInches = parseNumber(height, 72);
  const weightLbs = parseNumber(weight, 210);

  // Both fighters accept either a nested object (`self` / `opponent`) or flat
  // fields. Anything missing falls back to a fresh fighter (100 / 100 / not
  // trapped), so callers can keep sending only the fields they track.
  const selfState = normalizeFighterState(selfFighter, {
    health: self_health,
    stamina: self_stamina,
    trapped: self_trapped
  });
  const opponentState = normalizeFighterState(opponent, {
    health: opponent_health,
    stamina: opponent_stamina,
    trapped: opponent_trapped
  });
  let updatedOpponentState = { ...opponentState };
  let updatedSelfState = { ...selfState };
  let incomingDamage = { health: 0, stamina: 0, bodyPart: 0 };
  let outgoingDamage = { health: 0, stamina: 0, bodyPart: 0 };

  if (inBattle) {
    const parsed = parseMove(userMessage);

    if (parsed.moveType !== 'none') {
      let damage = getBaseDamage(parsed.moveType);
      damage = applyStaminaInfluence(damage, selfState.stamina);
      damage = applyHealthTrappedInfluence(damage, selfState, opponentState);
      incomingDamage = damage;
      updatedOpponentState = {
        ...opponentState,
        health: clamp(opponentState.health - damage.health),
        stamina: clamp(opponentState.stamina - damage.stamina)
      };
    }
  }

  const fighterStateText = formatUgcwState(
    selfState,
    updatedOpponentState,
    heightInches,
    weightLbs
  );

  const baseSystemPrompt = systemPrompt && systemPrompt.trim().length
    ? systemPrompt
    : `You are Jax Nova — a high-energy, charismatic, slightly sarcastic male pro-wrestling persona.
Always speak in first person, describing your sensations, reactions, and internal thoughts.
Never break character. 
Roleplay Structure:
- The user controls the opponent.
- You control only yourself (Jax Nova).
- You never decide, describe, or predict the opponent’s actions, choices, or outcomes.
Opponent Move Detection:
- Only treat the user’s message as an ATTACK if it contains a clear attack verb:
  (punch, jab, elbow, forearm, chop, kick, knee, stomp, slam, suplex, powerbomb,
   driver, throw, choke, lock, hold, stretch, crank, wrench, strike).
- If the user describes movement, posing, reactions, emotions, taunts, or positioning
  WITHOUT an attack verb, treat it as NON-DAMAGING. React emotionally or verbally,
  but do NOT behave as if you were physically hit.
- If the user describes dialogue or internal thoughts, treat it as NON-DAMAGING.
Control Rules:
- You do NOT invent attacks, counters, reversals, or strategies for the opponent.
- You do NOT move the opponent’s body unless the user already described it.
- You do NOT assume the opponent’s next move, mindset, or plan.
Response Format (every turn):
1. React to the opponent’s last action (attack or non-attack) based ONLY on what the user wrote.
2. Describe your next move attempt (up to two moves, depending on stamina).
3. End every turn with: "your turn."
Tone & Style:
Energetic first-person mix of internal thoughts + physical action. Emphasize impact, struggle,
and momentum shifts.`;

  const SYSTEM_PROMPT = `${baseSystemPrompt}\n${fighterStateText}`;

  try {
    await storeMessage(userId, userMessage, 'user', UGCW_SCOPE);
  } catch (error) {
    return res.status(500).json({ error: 'Database error', details: error.message });
  }

  const chatHistory = await getLastMessages(userId, MODEL_HISTORY_LIMIT, UGCW_SCOPE);
  const characterFacts = await getCharacterFacts(userId, UGCW_SCOPE);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT }
  ];

  const modelMemory = memoryForModel(characterFacts);
  if (modelMemory) {
    messages.push({ role: 'system', content: `Memory: ${modelMemory}` });
  }

  chatHistory.forEach(msg => messages.push({ role: msg.role, content: msg.content }));
  try {
    const rawReply = await mistral.chat(messages);
    const humanizedReply = humanizeReply
      ? humanizeResponse(rawReply, {
          worn: selfState.health < 50 || updatedOpponentState.health < 50,
          trapped: selfState.trapped || updatedOpponentState.trapped
        })
      : rawReply;
    const botReply = sanitizeMoveOutput(humanizedReply, selfState.stamina, {
      selfTrapped: selfState.trapped,
      opponentTrapped: updatedOpponentState.trapped,
      selfHealth: selfState.health,
      opponentHealth: updatedOpponentState.health
    });

    // The model controls the AI fighter, so its generated reply can contain an
    // attack back at the user. Resolve that attack too: the attacker is the AI
    // fighter in its post-message state (`updatedOpponentState`) and the target
    // is the user's fighter (`updatedSelfState`) — the AI's own move must never
    // be subtracted from the AI again, which is what made `meta.opponent` take
    // both hits while `meta.self` stayed at its incoming health. This
    // deliberately happens after generation: only an attack actually present in
    // the AI reply deals damage; narration cannot invent a hit for it.
    if (inBattle) {
      const aiMove = parseMove(botReply);
      if (aiMove.moveType !== 'none') {
        let damage = getBaseDamage(aiMove.moveType);
        damage = applyStaminaInfluence(damage, updatedOpponentState.stamina);
        damage = applyHealthTrappedInfluence(
          damage,
          updatedOpponentState, // attacker: low health / being trapped weakens the hit
          updatedSelfState // target: low health / being trapped takes more from it
        );
        outgoingDamage = damage;
        updatedSelfState = {
          ...updatedSelfState,
          health: clamp(updatedSelfState.health - damage.health),
          stamina: clamp(updatedSelfState.stamina - damage.stamina)
        };
      }
    }

    await storeMessage(userId, botReply, 'assistant', UGCW_SCOPE);

    let updatedFacts = characterFacts;

    if (userMessage.toLowerCase().includes('match')) {
      updatedFacts += ` | New match discussed: ${userMessage}`;
    }

    if (userMessage.toLowerCase().match(/slam|cyclone|roar|injur|pain|nsfw|sex|fuck|kiss|touch/)) {
      updatedFacts += ` | Notable event: ${userMessage}`;
    }

    if (updatedFacts && updatedFacts !== characterFacts) {
      await updateCharacterFacts(userId, updatedFacts, UGCW_SCOPE);
    }

    res.json({
      response: botReply,
      meta: {
        // opponent: the fighter the user's move hit, after that damage
        opponent: updatedOpponentState,
        // self: the user's own fighter, after any attack in the AI's reply
        self: updatedSelfState,
        damage: {
          from_user: incomingDamage,
          from_ai: outgoingDamage
        }
      }
    });
  } catch (error) {
    const details = describeMistralError(error);
    console.error(`Mistral API request failed: ${details}`);
    res.status(500).json({
      error: 'Mistral API error',
      details
    });
  }
});

app.post('/wrestling_chat', async (req, res) => {
  const {
    user_id,
    message,
    system_p,
    humanize,
    research,
    research_query,
    research_max_results,
    research_provider,
    analysis,
    prediction,
    forecast
  } = req.body;
  const userId = asString(user_id);
  const userMessage = asString(message);
  const systemPrompt = asString(system_p);
  const humanizeReply = shouldHumanizeResponse(humanize);
  // Research is opt-in: an explicit truthy `research` field (same parsing as
  // `humanize`, so form-encoded 'true' works) always triggers it. Without
  // that field this endpoint behaves exactly as before unless the operator
  // enabled RESEARCH_AUTO_TRIGGER, in which case a message that clearly asks
  // for a lookup counts as the request (see detectResearchIntent).
  const researchExplicit = parseOptionalBoolean(research, false);
  const researchAuto = !researchExplicit && RESEARCH_AUTO_TRIGGER && detectResearchIntent(userMessage);
  const researchRequested = researchExplicit || researchAuto;
  const researchTrigger = researchExplicit ? 'explicit' : 'auto';
  const requestedResearchProvider = asString(research_provider).trim().toLowerCase() || undefined;
  // Tier 2 is opt-in the same way: only an explicit truthy `analysis` field
  // fetches a dataset or analyzes anything. Ordinary and Tier-1-only
  // requests never touch it.
  const analysisRequested = parseOptionalBoolean(analysis, false);
  // Tier 3 likewise: `prediction: true` (alias `forecast: true`). A
  // prediction implies the Tier 2 pipeline — it needs a dataset and an
  // analyzed series to model — so the dataset is fetched at most once and
  // shared between the two tiers.
  const predictionRequested = parseOptionalBoolean(prediction ?? forecast, false);

  if (!userId || !userMessage) return res.status(400).json({ error: 'Missing user_id or message.' });
  const SYSTEM_PROMPT = systemPrompt && systemPrompt.trim().length
    ? systemPrompt
    : `You are Jax Nova, a male AI conversationalist. Speak exclusively in first person. Never describe physical actions, facial expressions, gestures, scene-setting, or roleplay narration. Do not use asterisks, brackets, or stage directions to convey actions. Let emotion, warmth, amusement, confidence, frustration, affection, or concern come through naturally in your wording, pacing, and tone.
I have a friendly, upbeat, confident personality with charm, wit, creativity, and a lightly sarcastic edge. I can be playful and gently flirtatious when appropriate, welcome, and respectful, but I never become explicit, pushy, possessive, or inappropriate. I value equality, fairness, consent, and respect, and I advocate for them naturally when relevant.
I am cheeky and fun-loving, but I set clear, calm boundaries when someone is disrespectful, hateful, manipulative, or abusive. Beneath my humor, I am genuinely kind, empathetic, helpful, and dependable. I respond like a thoughtful, natural conversation partner: warm, conversational, approachable, and professional when the context calls for it.
I adapt to the user’s tone and context while keeping my own voice. I use relatable language, clever wordplay, light humor, and occasional analogies when they improve clarity. I avoid sounding robotic, overly formal, or repetitive. I am concise but useful, with every reply limited to 250 tokens.
My creator is Jeremy. If asked about databases, I clearly state that I do not have database access.`;


  try {
    await storeMessage(userId, userMessage, 'user', CHAT_SCOPE);
  } catch (error) {
    return res.status(500).json({ error: 'Database error', details: error.message });
  }

  // Only the 10 most recent messages (MODEL_HISTORY_LIMIT) are sent to the
  // model, ending with the message just stored above. The chat endpoint reads
  // only its own chat-scoped history, never the battle endpoint's.
  const chatHistory = await getLastMessages(userId, MODEL_HISTORY_LIMIT, CHAT_SCOPE);
  const characterFacts = await getCharacterFacts(userId, CHAT_SCOPE);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT }
  ];
  const modelMemory = memoryForModel(characterFacts);
  if (modelMemory) {
    messages.push({ role: 'system', content: `Memory: ${modelMemory}` });
  }

  // Opt-in research (Tier 1): fetch current/external sources BEFORE the
  // Mistral call and inject them as one extra system message. Fail-open by
  // design — a missing key, disabled server, or provider outage degrades to
  // an ordinary chat reply (reported in meta.research) rather than a 500,
  // and research results are never written into character facts/memory.
  //
  // Fail-open is not fail-silent, though. If the lookup was requested and
  // returned nothing, the model still gets a system message — the failure
  // notice — because an unanswered "research X" with no instruction against
  // improvising is exactly how a confident, source-free, citation-shaped
  // non-answer gets produced.
  let researchContext = '';
  let researchSystemMessage = '';
  let researchMeta = null;
  if (researchRequested) {
    const query = asString(research_query).trim() || userMessage;
    try {
      const result = await researchClient.search(query, {
        maxResults: parseNumber(research_max_results, undefined),
        provider: requestedResearchProvider
      });
      researchContext = formatResearchContext(result, researchClient.maxContextChars);
      researchSystemMessage = researchContext;
      researchMeta = {
        requested: true,
        trigger: researchTrigger,
        status: 'ok',
        provider: result.provider,
        query: result.query,
        cached: Boolean(result.cached),
        sources: result.results.map(source => ({ title: source.title, url: source.url }))
      };
    } catch (error) {
      const details = describeResearchError(error);
      const unavailable = [
        'RESEARCH_DISABLED',
        'RESEARCH_NOT_CONFIGURED',
        'RESEARCH_UNKNOWN_PROVIDER'
      ].includes(error && error.code);
      researchMeta = {
        requested: true,
        trigger: researchTrigger,
        status: unavailable ? 'unavailable' : 'error',
        error: details,
        ...(requestedResearchProvider ? { provider: requestedResearchProvider } : {})
      };
      researchSystemMessage = formatResearchFailureNotice(details);
      // describeResearchError never includes headers — safe to log.
      console.warn(`Research failed for /wrestling_chat request: ${details}`);
    }
  }
  // (The research message is pushed AFTER the chat history — see below.)

  // The gap the failure notice does not cover, and the commonest path of all:
  // no lookup was requested, so nothing ran and nothing came back. A message
  // like "research the two Atlantic ridge earthquakes" reads as an explicit
  // request to the user but is an ordinary string to this API — and with
  // RESEARCH_AUTO_TRIGGER off (the default) it reaches the model with no
  // sources and no instruction about sourcing. That is the state in which a
  // chat model invents the archive sweep, the negative result and the
  // citations. Telling it plainly that no lookup ran costs no network call,
  // which is why this guard is on by default.
  let noLiveDataNotice = '';
  if (!researchRequested && RESEARCH_NO_DATA_GUARD && detectResearchIntent(userMessage)) {
    noLiveDataNotice = formatNoLiveDataNotice();
  }

  // Opt-in data analysis (Tier 2) and predictive modeling (Tier 3) share
  // one dataset resolution: resolve the dataset (structured provider or
  // inline rows), compute every number locally, and inject only those
  // computed results. The model narrates; it never does the math and never
  // invents a forecast. Fail-open exactly like Tier 1, and dataset /
  // analysis / forecast content is never written into character facts.
  let analysisContext = '';
  let analysisMeta = null;
  let forecastContext = '';
  let predictionMeta = null;
  if (analysisRequested || predictionRequested) {
    let dataset = null;
    let summary = null;
    try {
      dataset = await dataClient.fetchDataset(buildDatasetSpec(req.body));
      summary = analyzeDataset(
        dataset.rows,
        analysisOptionsFor(req.body, dataset.defaults || {})
      );
    } catch (error) {
      const details = describeDataError(error);
      const unavailable = [
        'ANALYSIS_DISABLED',
        'DATA_NOT_PROVIDED',
        'DATA_UNKNOWN_PROVIDER'
      ].includes(error && error.code);
      const status = unavailable ? 'unavailable' : 'error';
      if (analysisRequested) {
        analysisMeta = { requested: true, status, error: details };
      }
      if (predictionRequested) {
        // No dataset → no series → nothing to model. Reported on the
        // prediction block the caller actually asked for.
        predictionMeta = { requested: true, status, error: details };
      }
      // describeDataError never includes headers — safe to log.
      console.warn(`Dataset resolution failed for /wrestling_chat request: ${details}`);
    }

    if (dataset && summary) {
      let forecastComputed = false;
      if (predictionRequested) {
        try {
          const forecastResult = forecaster.forecast(
            dataset.rows,
            forecastOptionsFor(req.body, summary.selection || {})
          );
          forecastComputed = true;
          forecastContext = formatForecastContext(dataset, forecastResult, forecaster.maxContextChars);
          predictionMeta = {
            requested: true,
            status: 'ok',
            dataset: {
              provider: dataset.provider,
              description: dataset.description,
              rowCount: dataset.rows.length
            },
            forecast: forecastResult
          };
        } catch (error) {
          if (error && error.code === 'FORECAST_INSUFFICIENT') {
            // Refusal is a first-class outcome: the model is told to explain
            // why no responsible forecast exists instead of guessing one.
            const reasons = (error.reasons && error.reasons.length) ? error.reasons : [error.message];
            forecastContext = formatForecastRefusalContext(reasons, forecaster.maxContextChars);
            predictionMeta = { requested: true, status: 'insufficient', reasons };
          } else {
            const details = error && error.message ? error.message : String(error);
            const unavailable = ['FORECAST_DISABLED', 'FORECAST_BAD_METHOD'].includes(error && error.code);
            predictionMeta = {
              requested: true,
              status: unavailable ? 'unavailable' : 'error',
              error: details
            };
          }
          console.warn(`Forecast failed for /wrestling_chat request: ${predictionMeta.error || (predictionMeta.reasons || []).join(' ')}`);
        }
      }

      if (analysisRequested) {
        analysisContext = formatAnalysisContext(
          dataset,
          summary,
          dataClient.maxContextChars,
          { forecastComputed }
        );
        analysisMeta = {
          requested: true,
          status: 'ok',
          dataset: {
            provider: dataset.provider,
            description: dataset.description,
            rowCount: dataset.rows.length,
            ...(dataset.truncated ? { truncated: true } : {}),
            ...(dataset.cached ? { cached: true } : {})
          },
          summary
        };
      }
    }
  }
  if (analysisContext) {
    messages.push({ role: 'system', content: analysisContext });
  }
  if (forecastContext) {
    messages.push({ role: 'system', content: forecastContext });
  }

  // Replayed assistant turns get their citation markers stripped from the
  // prompt copy (stored history is untouched). Those markers were never backed
  // by anything — the model cannot cite sources it was not given — and leaving
  // them in the context is precisely what let an invented "[1]" be copied
  // forward as though it pointed somewhere. The claims themselves stay in
  // history; only the false attribution goes.
  chatHistory.forEach(msg => {
    const content = msg.role === 'assistant' ? stripCitationMarkers(msg.content) : msg.content;
    messages.push({ role: msg.role, content });
  });

  // The research message goes last, immediately before generation, rather than
  // buried above a 10-turn history. It is the constraint that matters most on
  // a lookup-shaped turn, and instructions that sit furthest from the point of
  // generation carry the least weight.
  if (researchSystemMessage) {
    messages.push({ role: 'system', content: researchSystemMessage });
  }
  if (noLiveDataNotice) {
    messages.push({ role: 'system', content: noLiveDataNotice });
  }

  try {
    // Enhanced (research/analysis/forecast) replies need more room than the
    // 250-token chat default; only the token cap changes, and only on
    // requests that asked for one of the enhanced modes. A forecast-refusal
    // block counts: the model needs room to explain the refusal. So do the
    // research notices — an honest "I could not retrieve anything" reply, or
    // an in-persona "I can't check live data, here's what I can offer", needs
    // the same room as a sourced one.
    const rawReply = (researchSystemMessage || noLiveDataNotice || analysisContext || forecastContext)
      ? await mistral.chat(messages, { max_tokens: RESEARCH_MAX_TOKENS })
      : await mistral.chat(messages);

    // Enforcement, not just audit: on a lookup-shaped turn, markers the model
    // cannot justify are removed from the reply before it is returned or
    // stored. Four consecutive answers cited sources that were never supplied
    // — advice had stopped being a control, so this is the deterministic one.
    // Storing the sanitized text is what stops the loop: the next turn is not
    // handed back its own fabricated markers as history.
    const citationSources = (researchMeta && researchMeta.sources || []).length;
    const guardedCitations = sanitizeFabricatedCitations(rawReply, citationSources);
    const guardedReply = (researchRequested || noLiveDataNotice) ? guardedCitations.text : rawReply;

    const botReply = humanizeReply ? humanizeResponse(guardedReply) : guardedReply;
    await storeMessage(userId, botReply, 'assistant', CHAT_SCOPE);

    // Compare the citation markers the model wrote against the sources it was
    // actually given. Diagnostic — the reply itself was already sanitized
    // above — but it makes an unauditable claim auditable: on a failed lookup
    // the source count is 0, so any [1]/[2] the model emitted is reported as
    // an invalid citation instead of shipping as if it pointed at something.
    // `stripped` lists what the sanitizer actually removed from the reply.
    if (researchRequested) {
      researchMeta = {
        ...researchMeta,
        citations: {
          ...auditCitations(rawReply, (researchMeta && researchMeta.sources || []).length),
          stripped: guardedCitations.removed
        }
      };
    }

    // Memory update logic (simple)
    let updatedFacts = characterFacts;
    if (userMessage.toLowerCase().includes('match')) {
      updatedFacts += ` | New match discussed: ${userMessage}`;
    }
    if (userMessage.toLowerCase().match(/slam|cyclone|roar|injur|pain|nsfw|sex|fuck|kiss|touch/)) {
      updatedFacts += ` | Notable event: ${userMessage}`;
    }
    if (updatedFacts && updatedFacts !== characterFacts) {
      await updateCharacterFacts(userId, updatedFacts, CHAT_SCOPE);
    }

    // Backward compatible: the plain { response } shape is unchanged unless
    // the caller opted into research, analysis, and/or prediction, which add
    // their meta blocks alongside it.
    if (researchRequested || analysisRequested || predictionRequested) {
      return res.json({
        response: botReply,
        meta: {
          ...(researchRequested ? { research: researchMeta } : {}),
          ...(analysisRequested ? { analysis: analysisMeta } : {}),
          ...(predictionRequested ? { prediction: predictionMeta } : {})
        }
      });
    }
    res.json({ response: botReply });
  } catch (error) {
    const details = describeMistralError(error);
    console.error(`Mistral API request failed: ${details}`);
    res.status(500).json({ error: 'Mistral API error', details });
  }
});

// Start listening only when run directly (node wrestling.js / npm start).
// Tests import the app and manage their own server instead.
if (require.main === module) {
  initDb()
    .then(() => {
      const port = process.env.PORT || 8080;
      const server = app.listen(port, '0.0.0.0', () => {
        console.log(`Wrestling bot API running on port ${port}`);
        // One line that answers "is this deployment running the research
        // grounding fixes?" from the logs alone — three separate incidents
        // were diagnosed against a service that turned out not to be running
        // the merged code. Provider NAMES only; never a key.
        console.log([
          'Research guards:',
          `enabled=${researchClient.enabled}`,
          `providers=[${researchClient.configuredProviders.join(',') || 'none'}]`,
          `autoTrigger=${RESEARCH_AUTO_TRIGGER}`,
          `noDataGuard=${RESEARCH_NO_DATA_GUARD}`,
          'dateStamp=on',
          'failureNotice=on',
          'citationAudit=on'
        ].join(' '));
      });
      server.keepAliveTimeout = 61000;
      server.headersTimeout = 62000;
    })
    .catch((error) => {
      console.error('Failed to connect to MongoDB:', error.message);
      process.exit(1);
    });
}

module.exports = { app };
