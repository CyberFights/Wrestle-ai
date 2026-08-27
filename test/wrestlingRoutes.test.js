'use strict';

/*
 * Route-level behavior test for wrestling.js — run with: npm test
 *
 * Boots the REAL express app against two fakes:
 *   • memoryStore.js → in-memory stand-in with the same exported API
 *   • the Mistral API → a local stub HTTP server
 *
 * …and pins down the exact API contract the app has always had:
 *   POST /wrestling_bot  → { response, updated_stats, meta }   (+ damage math)
 *   POST /wrestling_chat → { response }
 *   errors               → 400 / 500 shapes
 *   the model receives only the 10 most recent messages, each exactly once.
 *
 * The app exports `app` and only listens when run directly, so this file
 * creates (and cleanly closes) its own server.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('module');

const PORT = 18991;
const API_KEY = 'route-test-key';

// ---------- in-memory memoryStore stand-in (same API as memoryStore.js) ----------

const chats = new Map(); // user_id → [{ role, content }]
const facts = new Map(); // user_id → string
const calls = { storeMessage: [], getLastMessages: [] };

const fakeMemoryStore = {
  MODEL_HISTORY_LIMIT: 10,
  async initDb() {},
  async storeMessage(userId, message, role) {
    calls.storeMessage.push({ userId: String(userId), role });
    const id = String(userId);
    if (!chats.has(id)) chats.set(id, []);
    chats.get(id).push({ role, content: message });
  },
  async getLastMessages(userId, limit = 10) {
    const returned = (chats.get(String(userId)) || []).slice(-limit).map(m => ({ ...m }));
    calls.getLastMessages.push({ userId: String(userId), limit, returned });
    return returned;
  },
  async getCharacterFacts(userId) {
    return facts.get(String(userId)) || '';
  },
  async updateCharacterFacts(userId, nextFacts) {
    facts.set(String(userId), nextFacts);
  }
};

// ---------- stub Mistral API ----------

const mistralRequests = [];
let stubStatus = 200;
const STUB_REPLY = 'I stagger back, grinning. your turn.';

const mistralStub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    mistralRequests.push({ authorization: req.headers.authorization, body: JSON.parse(raw || '{}') });
    res.writeHead(stubStatus, { 'Content-Type': 'application/json' });
    if (stubStatus === 200) {
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: STUB_REPLY } }] }));
    } else {
      res.end(JSON.stringify({ message: 'service unavailable' }));
    }
  });
});

// ---------- helpers ----------

function requestRaw(method, path, rawBody, headers = { 'Content-Type': 'application/json' }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path, method, headers },
      res => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch (err) { /* leave null */ }
          resolve({ status: res.statusCode, body: parsed, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    req.end(rawBody);
  });
}

function request(method, path, body) {
  return requestRaw(method, path, body == null ? undefined : JSON.stringify(body));
}

function requestForm(method, path, body) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body || {})) {
    params.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return requestRaw(
    method,
    path,
    params.toString(),
    { 'Content-Type': 'application/x-www-form-urlencoded' }
  );
}

// ---------- boot ----------

let server;

before(async () => {
  await new Promise(resolve => mistralStub.listen(0, '127.0.0.1', resolve));

  process.env.MISTRAL_API_KEY = API_KEY;
  process.env.MISTRAL_API_URL = `http://127.0.0.1:${mistralStub.address().port}/v1/chat/completions`;
  process.env.MISTRAL_MAX_RETRIES = '0'; // keep the failure-case test instant

  // Swap memoryStore for the in-memory stand-in before the app loads it.
  const originalLoad = Module._load;
  Module._load = function load(request, parent) {
    if (parent && parent.filename.endsWith('wrestling.js') && request === './memoryStore') {
      return fakeMemoryStore;
    }
    return originalLoad.apply(this, arguments);
  };

  const { app } = require('../wrestling.js');
  await new Promise(resolve => {
    server = app.listen(PORT, '127.0.0.1', resolve);
  });
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => mistralStub.close(resolve));
});

// ---------- tests ----------

test('GET / keeps its old "private interface" 500 guard', async () => {
  const res = await request('GET', '/');
  assert.equal(res.status, 500);
  assert.match(res.body.error, /private/i);
});

test('POST endpoints return a clean JSON 400 for malformed JSON bodies', async () => {
  const storedBefore = calls.storeMessage.length;
  const mistralBefore = mistralRequests.length;

  // This mimics a caller interpolating prompt text containing quotes instead
  // of passing the full object through JSON.stringify.
  const res = await requestRaw(
    'POST',
    '/wrestling_bot',
    '{"user_id":"broken","message":"I yell "your turn.""}'
  );

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Invalid JSON body.');
  assert.match(res.body.details, /serialize/i);
  assert.equal(typeof res.body.request_id, 'string');
  assert.equal(res.headers['x-request-id'], res.body.request_id);
  assert.equal(typeof res.body.snippet, 'string');
  assert.ok(res.body.snippet.includes('our turn'));
  assert.equal(calls.storeMessage.length, storedBefore, 'the malformed request must not reach the route');
  assert.equal(mistralRequests.length, mistralBefore, 'the malformed request must not reach Mistral');
});

test('POST endpoints return diagnostic snippet when token y is unexpected (e.g. unquoted yes)', async () => {
  const res = await requestRaw(
    'POST',
    '/wrestling_bot',
    '{"user_id":"u1","in_battle":yes,"message":"hello"}'
  );

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Invalid JSON body.');
  assert.equal(typeof res.body.snippet, 'string');
  assert.ok(res.body.snippet.includes('yes') || res.body.snippet.includes('in_battle'));
});

test('POST /wrestling_bot keeps the 400 shape on missing fields', async () => {
  const res = await request('POST', '/wrestling_bot', { user_id: 'route-user' });
  assert.deepEqual(res.status, 400);
  assert.deepEqual(res.body, { error: 'Missing user_id or message.' });
});

test('POST /wrestling_bot accepts form-encoded fields when JSON escaping is awkward', async () => {
  mistralRequests.length = 0;
  const stats = { health: 91, stamina: 87, head: 2, ribs: 3, arms: 4, legs: 5 };
  const message = 'I shout "your turn" without throwing a strike.\nStill just talking.';

  const res = await requestForm('POST', '/wrestling_bot', {
    user_id: 'form-user',
    message,
    in_battle: 'false',
    height: '72',
    weight: '210',
    stats
  });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.updated_stats, stats, 'form-encoded false must not be treated as truthy');
  assert.equal(res.body.meta.target, null);
  assert.equal(res.body.meta.repeated_count, 0);

  const conversation = mistralRequests[mistralRequests.length - 1].body.messages.filter(m => m.role !== 'system');
  assert.equal(conversation[conversation.length - 1].content, message);
});

test('POST /wrestling_bot success contract: response + updated_stats + meta', async () => {
  const res = await request('POST', '/wrestling_bot', {
    user_id: 'stats-user',
    message: 'I punch your jaw',
    in_battle: true,
    height: 72,
    weight: 210,
    stats: { health: 100, stamina: 100, head: 0, ribs: 0, arms: 0, legs: 0 },
    previous_target: null,
    repeated_count: 0
  });

  assert.equal(res.status, 200);
  assert.equal(typeof res.body.response, 'string');
  assert.ok(res.body.response.endsWith('your turn.'));

  // strike to the head at 72in/210lb: health -5, stamina -4, head +8
  assert.deepEqual(res.body.updated_stats, { health: 95, stamina: 96, head: 8, ribs: 0, arms: 0, legs: 0 });
  assert.deepEqual(res.body.meta, { target: 'head', repeated_count: 1 });

  // both turns were stored, in order
  const stored = calls.storeMessage.filter(c => c.userId === 'stats-user').map(c => c.role);
  assert.deepEqual(stored, ['user', 'assistant']);
});

test('the model only ever receives the 10 most recent messages, each exactly once', async () => {
  mistralRequests.length = 0;
  calls.getLastMessages.length = 0;

  for (let i = 1; i <= 14; i += 1) {
    const res = await request('POST', '/wrestling_bot', { user_id: 'window-user', message: `message ${i}` });
    assert.equal(res.status, 200);
  }

  const lastCall = mistralRequests[mistralRequests.length - 1].body;
  const conversation = lastCall.messages.filter(m => m.role !== 'system');

  assert.equal(conversation.length, 10, 'model context must be exactly the last 10 messages');
  // The payload must be exactly what the history fetch returned for this turn:
  // the 10 most recent stored entries (user and assistant turns interleaved),
  // in order, ending with the current message.
  const historyFetch = calls.getLastMessages[calls.getLastMessages.length - 1];
  assert.deepEqual(conversation, historyFetch.returned);
  assert.equal(conversation[conversation.length - 1].role, 'user');
  assert.equal(
    conversation[conversation.length - 1].content,
    'message 14',
    'the current message must be the last entry'
  );
  assert.equal(
    conversation.filter(m => m.content === 'message 14').length,
    1,
    'the latest user message must appear exactly once (it was duplicated before)'
  );
  assert.ok(calls.getLastMessages.every(c => c.limit === 10), 'history fetch must ask for 10');
});

test('character facts still flow into the prompt as the Memory system message', async () => {
  mistralRequests.length = 0;

  await request('POST', '/wrestling_bot', { user_id: 'facts-user', message: 'that match was wild' });
  assert.ok(facts.get('facts-user').includes('New match discussed: that match was wild'));

  await request('POST', '/wrestling_bot', { user_id: 'facts-user', message: 'hello again' });
  const lastMessages = mistralRequests[mistralRequests.length - 1].body.messages;
  const memoryMessage = lastMessages.find(m => m.role === 'system' && m.content.startsWith('Memory: '));
  assert.ok(memoryMessage, 'a Memory system message must be present');
  assert.match(memoryMessage.content, /New match discussed: that match was wild/);
});

test('long character facts are capped before sending them to Mistral', async () => {
  mistralRequests.length = 0;
  facts.set('long-facts-user', `old-start-${'x'.repeat(6500)}RECENT_MARKER`);

  const res = await request('POST', '/wrestling_bot', { user_id: 'long-facts-user', message: 'hello again' });

  assert.equal(res.status, 200);
  const lastMessages = mistralRequests[mistralRequests.length - 1].body.messages;
  const memoryMessage = lastMessages.find(m => m.role === 'system' && m.content.startsWith('Memory: '));
  assert.ok(memoryMessage, 'a Memory system message must be present');
  assert.ok(memoryMessage.content.includes('Earlier memory omitted'));
  assert.ok(memoryMessage.content.includes('RECENT_MARKER'), 'recent facts should be preserved');
  assert.ok(!memoryMessage.content.includes('old-start-'), 'oldest facts should be omitted');
  assert.ok(memoryMessage.content.length < 6200, 'model-visible memory stays bounded');
});

test('POST /wrestling_chat success contract is unchanged', async () => {
  const before = mistralRequests.length;
  const res = await request('POST', '/wrestling_chat', { user_id: 'chat-user', message: 'yo Jax' });

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), ['response'], 'chat endpoint returns only { response }');
  assert.equal(res.body.response, STUB_REPLY);

  const payload = mistralRequests[mistralRequests.length - 1].body;
  assert.equal(payload.max_tokens, 250);
  assert.equal(payload.temperature, 0.8);
  assert.equal(payload.model, 'mistral-large-latest');
  assert.ok(mistralRequests.length > before);
});

test('a Mistral 503 still surfaces as the same 500 error shape (and leaks no key)', async () => {
  stubStatus = 503;
  try {
    const res = await request('POST', '/wrestling_bot', { user_id: 'err-user', message: 'any move' });
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'Mistral API error');
    assert.equal(typeof res.body.details, 'string');
    assert.match(res.body.details, /503/);
    assert.ok(!res.body.details.includes(API_KEY), 'details must never contain the API key');
  } finally {
    stubStatus = 200;
  }
});
