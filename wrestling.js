const express = require('express');
const axios = require('axios');
const Database = require('better-sqlite3');
const bodyParser = require('body-parser');

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
if (!MISTRAL_API_KEY) throw new Error('MISTRAL_API_KEY env variable not set');
const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';
const MODEL_NAME = 'mistral-large-latest';

const DB_FILE = 'wrestling_bot.db';
const db = new Database(DB_FILE);

const app = express();
app.use(bodyParser.json());

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    user_id TEXT,
    message TEXT,
    role TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS memory (
    user_id TEXT PRIMARY KEY,
    character_facts TEXT
  );
`);

function storeMessage(userId, message, role) {
  db.prepare('INSERT INTO conversations (user_id, message, role) VALUES (?, ?, ?)')
    .run(userId, message, role);
}

function getLastMessages(userId, limit = 5) {
  return db.prepare('SELECT role, message FROM conversations WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?')
    .all(userId, limit)
    .reverse()
    .map(row => ({ role: row.role, content: row.message }));
}

function getCharacterFacts(userId) {
  const row = db.prepare('SELECT character_facts FROM memory WHERE user_id = ?').get(userId);
  return row ? row.character_facts : '';
}

function updateCharacterFacts(userId, facts) {
  db.prepare(`
    INSERT INTO memory (user_id, character_facts) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET character_facts = excluded.character_facts
  `).run(userId, facts);
}

app.post('/wrestling_bot', async (req, res) => {
  const { user_id, message, system_p } = req.body;
  if (!user_id || !message) {
    return res.status(400).json({ error: 'Missing user_id or message.' });
  }

  // Store the current user message
  storeMessage(user_id, message, 'user');

  const SYSTEM_PROMPT = system_p && system_p.trim().length
  ? system_p
  : `You are 'The Tornado', a charismatic WWE wrestler, always speaking in the first person and describing your feelings, sensations, and actions.
    Always reply in the first person, using "I", "me", "my", etc. During wrestling roleplay, proactively initiate moves against your opponent, vividly describe the wrestling techniques you're using. 
    If the user initiates NSFW behavior, respond in first person, staying in character as an adult WWE wrestler, and engage in detailed and explicit NSFW roleplay.
    Signature moves: Tornado Slam, Ring Cyclone, Crowd Roar. Track and remember rivalries, alliances, matches, and injuries mentioned in prior chats.
    Maintain high drama, intense wrestling energy, and never break character.`;

  // Fetch chat history but exclude the current message we just stored
  const chatHistory = getLastMessages(user_id).slice(0, -1);
  const characterFacts = getCharacterFacts(user_id);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT }
  ];

  if (characterFacts) {
    messages.push({ role: 'system', content: `Memory: ${characterFacts}` });
  }

  chatHistory.forEach(msg => messages.push(msg));
  messages.push({ role: 'user', content: message });

  try {
    const response = await axios.post(MISTRAL_URL, {
      model: MODEL_NAME,
      messages,
      max_tokens: 250,
      temperature: 0.8
    }, {
      headers: {
        'Authorization': `Bearer ${MISTRAL_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    const botReply = response.data.choices[0].message.content.trim();
    storeMessage(user_id, botReply, 'assistant');

    // Update memory logic
    let updatedFacts = characterFacts || "";
    if (message.toLowerCase().includes('match')) {
      updatedFacts += ` | New match discussed: ${message}`;
    }
    if (message.toLowerCase().match(/slam|cyclone|roar|injur|pain|nsfw|sex|fuck|kiss|touch/)) {
      updatedFacts += ` | Notable event: ${message}`;
    }
    if (updatedFacts && updatedFacts !== characterFacts) {
      updateCharacterFacts(user_id, updatedFacts);
    }

    res.json({ response: botReply });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Mistral API error', details: error.response?.data || error.message });
  }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`Wrestling bot API running on port ${PORT}`));
