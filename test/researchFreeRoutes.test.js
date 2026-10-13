'use strict';

/*
 * Route-level test for KEYLESS research on POST /wrestling_chat.
 *
 * Same boot pattern as researchRoutes.test.js (real express app, in-memory
 * memoryStore, stub Mistral), but here the server has NO provider API keys
 * at all: the only research configuration is DUCKDUCKGO_API_URL pointing at
 * a local stub of the free DuckDuckGo Instant Answer API. This pins down
 * the promise that research works out of the box with no key, no signup
 * and no account — while still only running when explicitly requested.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('module');

// ---------- in-memory memoryStore stand-in (same API as memoryStore.js) ----------

const chats = new Map();

function scopeKey(userId, scope) {
  return `${String(userId)}|${scope}`;
}

const fakeMemoryStore = {
  MODEL_HISTORY_LIMIT: 10,
  async initDb() {},
  async storeMessage(userId, message, role, scope) {
    const id = scopeKey(userId, scope);
    if (!chats.has(id)) chats.set(id, []);
    chats.get(id).push({ role, content: message });
  },
  async getLastMessages(userId, limit = 10, scope) {
    return (chats.get(scopeKey(userId, scope)) || []).slice(-limit).map(m => ({ ...m }));
  },
  async getCharacterFacts() { return ''; },
  async updateCharacterFacts() {}
};

// ---------- stub Mistral API ----------

const mistralRequests = [];
const STUB_REPLY = 'Here is what I found, no keys involved.';

const mistralStub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    mistralRequests.push({ body: JSON.parse(raw || '{}') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: STUB_REPLY } }] }));
  });
});

// ---------- stub keyless provider (DuckDuckGo Instant Answer shape) ----------

const duckRequests = [];

const duckStub = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  duckRequests.push({ headers: req.headers, query: url.searchParams });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    Heading: 'Photosynthesis',
    AbstractURL: 'https://example.com/photosynthesis',
    AbstractText: 'Photosynthesis is a biological process used by plants to convert light into energy.',
    Results: [],
    RelatedTopics: []
  }));
});

// ---------- helpers / boot ----------

let server;
let port;

function request(body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/wrestling_chat', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      }
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

before(async () => {
  await new Promise(resolve => mistralStub.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => duckStub.listen(0, '127.0.0.1', resolve));

  process.env.MISTRAL_API_KEY = 'route-test-key';
  process.env.MISTRAL_API_URL = `http://127.0.0.1:${mistralStub.address().port}/v1/chat/completions`;
  process.env.MISTRAL_MAX_RETRIES = '0';

  // The whole point of this file: no provider keys exist in this server.
  delete process.env.TAVILY_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.EXA_API_KEY;
  delete process.env.SERPER_API_KEY;

  // Only the keyless provider's endpoint is pointed at the stub; in
  // production this env var is unset and the real free API is used.
  process.env.DUCKDUCKGO_API_URL = `http://127.0.0.1:${duckStub.address().port}/`;
  process.env.RESEARCH_PROVIDERS = 'duckduckgo';
  process.env.RESEARCH_CACHE_TTL_MS = '0';

  const originalLoad = Module._load;
  Module._load = function load(requestName, parent) {
    if (parent && parent.filename.endsWith('wrestling.js') && requestName === './memoryStore') {
      return fakeMemoryStore;
    }
    return originalLoad.apply(this, arguments);
  };

  const { app } = require('../wrestling.js');
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => mistralStub.close(resolve));
  await new Promise(resolve => duckStub.close(resolve));
});

// ---------- tests ----------

test('research works with no API key configured anywhere', async () => {
  mistralRequests.length = 0;
  duckRequests.length = 0;

  const res = await request({
    user_id: 'free-user',
    message: 'What is photosynthesis?',
    research: true
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.response, STUB_REPLY);
  assert.equal(res.body.meta.research.status, 'ok');
  assert.equal(res.body.meta.research.provider, 'duckduckgo');
  assert.deepEqual(res.body.meta.research.sources, [
    { title: 'Photosynthesis', url: 'https://example.com/photosynthesis' }
  ]);

  // The keyless call carried no credential of any kind.
  assert.equal(duckRequests.length, 1);
  assert.equal(duckRequests[0].query.get('q'), 'What is photosynthesis?');
  assert.equal(duckRequests[0].headers['x-api-key'], undefined);
  assert.equal(duckRequests[0].headers.authorization, undefined);

  // And the retrieved text reached Mistral inside the research block.
  const payload = mistralRequests[mistralRequests.length - 1].body;
  const block = payload.messages.find(m => String(m.content).includes('<research_data>'));
  assert.ok(block, 'a research context block must be injected');
  assert.match(block.content, /Photosynthesis is a biological process/);
});

test('keyless research is still strictly opt-in', async () => {
  duckRequests.length = 0;

  const res = await request({ user_id: 'free-user', message: 'just chatting' });

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), ['response'], 'no meta without the research flag');
  assert.equal(duckRequests.length, 0, 'the free API must not be called for ordinary chat');
});
