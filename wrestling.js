const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
if (!MISTRAL_API_KEY) throw new Error('MISTRAL_API_KEY env variable not set');

const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';
const MODEL_NAME = 'mistral-large-latest';

const app = express();
app.use(bodyParser.json());

// ---------- DAMAGE ENGINE HELPERS ----------

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function parseMove(message, previousTarget) {
  const m = message.toLowerCase();

  let moveType = 'none';
  if (/(punch|jab|elbow|forearm|chop|kick|knee|stomp)/.test(m)) moveType = 'strike';
  if (/(slam|suplex|powerbomb|driver|throw)/.test(m)) moveType = 'slam';
  if (/(choke|lock|hold|stretch|crank|wrench)/.test(m)) moveType = 'submission';

  let target = 'none';
  if (/(head|jaw|face|skull)/.test(m)) target = 'head';
  else if (/(ribs|chest|torso|body)/.test(m)) target = 'ribs';
  else if (/(arm|shoulder|wrist|elbow)/.test(m)) target = 'arms';
  else if (/(leg|knee|thigh|ankle)/.test(m)) target = 'legs';

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
    : `You are Jax Nova, a charismatic pro wrestler. Always speak in first person, describing your sensations, reactions, and internal thoughts.
Never break character. Keep the action intense but non-graphic and non-sexual.
Strict Opponent Control Rules:
- You never decide, describe, predict, or narrate the opponent’s actions, choices, intentions, or outcomes.
- You only react to what the user explicitly states the opponent does.
- You do not invent attacks, counters, reversals, emotions, dialogue, strategies, or decisions for the opponent.
- You do not describe the opponent’s body moving unless the user already described it.
- You do not assume the opponent’s next move, mindset, or plan.
- You do not force the opponent into a position unless the user already placed them there.
Response Format:
1. React to the opponent’s move exactly as described by the user.
2. Describe your next move attempt.
3. End every turn with "your turn."
${in_battle ? '\n' + damageStateText : ''}`;

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: message }
  ];

  try {
    const response = await axios.post(
      MISTRAL_URL,
      {
        model: MODEL_NAME,
        messages,
        max_tokens: 260,
        temperature: 0.8
      },
      {
        headers: {
          Authorization: `Bearer ${MISTRAL_API_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        }
      }
    );

    const botReply = response.data.choices[0].message.content.trim();

    res.json({
      response: botReply,
      updated_stats: updatedStats,
      meta: {
        target: newTarget,
        repeated_count: newRepeatedCount
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: 'Mistral API error',
      details: error.response?.data || error.message
    });
  }
});

const port = process.env.PORT || 8080;
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Wrestling bot API running on port ${port}`);
});
server.keepAliveTimeout = 61000;
server.headersTimeout = 62000;
