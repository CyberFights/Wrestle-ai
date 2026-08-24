const express = require('express');
const bodyParser = require('body-parser');
const { sanitizeMoveOutput } = require('./moveSanitizer');
const { createMistralClient, describeMistralError } = require('./mistralClient');
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
app.use(bodyParser.json());

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

// ---------- ROUTES ----------

app.get('/', (req, res) => {
  return res.status(500).json({
    error: 'this is a private Ai interface not meant for public use, without the correct key you cannot use it, your ipaddress has been logged'
  });
});

app.post('/wrestling_bot', async (req, res) => {
  const { user_id, message, system_p, in_battle, height, weight, stats, previous_target, repeated_count } = req.body;

  if (!user_id || !message) {
    return res.status(400).json({ error: 'Missing user_id or message.' });
  }

  const safeStats = {
    health: stats?.health ?? 100,
    stamina: stats?.stamina ?? 100,
    head: stats?.head ?? 0,
    ribs: stats?.ribs ?? 0,
    arms: stats?.arms ?? 0,
    legs: stats?.legs ?? 0
  };

  let updatedStats = { ...safeStats };
  let newTarget = previous_target || null;
  let newRepeatedCount = repeated_count || 0;

  if (in_battle) {
    const parsed = parseMove(message, previous_target || null);

    if (parsed.moveType !== 'none') {
      const base = getBaseDamage(parsed.moveType);
      let dmg = applyScaling(base, height || 72, weight || 210);

      if (parsed.target && parsed.target !== 'none') {
        if (parsed.target === previous_target) {
          newRepeatedCount = (repeated_count || 1) + 1;
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

  const damageStateText = in_battle ? formatDamageState(updatedStats) : '';

  const SYSTEM_PROMPT = system_p && system_p.trim().length
    ? system_p
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
${in_battle ? '\n' + damageStateText : ''}`;

  // Store user message immediately (same as wrestling_chat)
try {
  await storeMessage(user_id, message, 'user');
} catch (error) {
  return res.status(500).json({ error: 'Database error', details: error.message });
}

// Load conversation history + memory.
// Only the 10 most recent messages (MODEL_HISTORY_LIMIT) are sent to the
// model — and since storeMessage() above already saved the current message,
// the history ends with it: do NOT append `message` again here.
const chatHistory = await getLastMessages(user_id, MODEL_HISTORY_LIMIT);
const characterFacts = await getCharacterFacts(user_id);

const messages = [
  { role: 'system', content: SYSTEM_PROMPT }
];

if (characterFacts) {
  messages.push({ role: 'system', content: `Memory: ${characterFacts}` });
}

chatHistory.forEach(msg => messages.push({ role: msg.role, content: msg.content }));
try {
const rawReply = await mistral.chat(messages);
const botReply = sanitizeMoveOutput(rawReply, updatedStats.stamina);

// Store assistant reply
await storeMessage(user_id, botReply, 'assistant');
    
    let updatedFacts = characterFacts;

if (message.toLowerCase().includes('match')) {
  updatedFacts += ` | New match discussed: ${message}`;
}

if (message.toLowerCase().match(/slam|cyclone|roar|injur|pain|nsfw|sex|fuck|kiss|touch/)) {
  updatedFacts += ` | Notable event: ${message}`;
}

if (updatedFacts && updatedFacts !== characterFacts) {
  await updateCharacterFacts(user_id, updatedFacts);
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
  const { user_id, message, system_p } = req.body;
  if (!user_id || !message) return res.status(400).json({ error: 'Missing user_id or message.' });
  const SYSTEM_PROMPT = system_p && system_p.trim().length
    ? system_p
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


  try {
    await storeMessage(user_id, message, 'user');
  } catch (error) {
    return res.status(500).json({ error: 'Database error', details: error.message });
  }

  // Only the 10 most recent messages (MODEL_HISTORY_LIMIT) are sent to the
  // model, ending with the message just stored above.
  const chatHistory = await getLastMessages(user_id, MODEL_HISTORY_LIMIT);
  const characterFacts = await getCharacterFacts(user_id);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT }
  ];
  if (characterFacts) {
    messages.push({ role: 'system', content: `Memory: ${characterFacts}` });
  }
  chatHistory.forEach(msg => messages.push({ role: msg.role, content: msg.content }));

  try {
    const botReply = await mistral.chat(messages);
    await storeMessage(user_id, botReply, 'assistant');

    // Memory update logic (simple)
    let updatedFacts = characterFacts;
    if (message.toLowerCase().includes('match')) {
      updatedFacts += ` | New match discussed: ${message}`;
    }
    if (message.toLowerCase().match(/slam|cyclone|roar|injur|pain|nsfw|sex|fuck|kiss|touch/)) {
      updatedFacts += ` | Notable event: ${message}`;
    }
    if (updatedFacts && updatedFacts !== characterFacts) {
      await updateCharacterFacts(user_id, updatedFacts);
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
