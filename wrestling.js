const crypto = require('crypto');
const express = require('express');
const bodyParser = require('body-parser');
const { sanitizeMoveOutput } = require('./moveSanitizer');
const { humanizeResponse } = require('./humanizer');
const { createMistralClient, describeMistralError } = require('./mistralClient');
const { CHAT_SCOPE, BATTLE_SCOPE } = require('./memoryFolders');
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

  const SYSTEM_PROMPT = systemPrompt && systemPrompt.trim().length
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
and momentum shifts.
${inBattle ? '\n' + damageStateText : ''}`;

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

app.post('/wrestling_chat', async (req, res) => {
  const { user_id, message, system_p, humanize } = req.body;
  const userId = asString(user_id);
  const userMessage = asString(message);
  const systemPrompt = asString(system_p);
  const humanizeReply = shouldHumanizeResponse(humanize);

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
  chatHistory.forEach(msg => messages.push({ role: msg.role, content: msg.content }));

  try {
    const rawReply = await mistral.chat(messages);
    const botReply = humanizeReply ? humanizeResponse(rawReply) : rawReply;
    await storeMessage(userId, botReply, 'assistant', CHAT_SCOPE);

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
