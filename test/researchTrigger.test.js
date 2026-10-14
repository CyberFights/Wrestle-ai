'use strict';

/*
 * Route-level tests for the two grounding fixes on POST /wrestling_chat.
 *
 * 1. RESEARCH_AUTO_TRIGGER. The endpoint's contract is strict opt-in — only
 *    the request's `research` field starts a lookup — but a user who types
 *    "research the two Atlantic ridge earthquakes" into a chat box has asked
 *    for research, and the API never sees that intent: it sees a string.
 *    Without this mode the message goes to a chat model with no sources and
 *    no instruction against improvising them, which is how a confident
 *    archive-sweep non-answer gets produced. This file boots the REAL app
 *    with the mode ON and pins down both halves: a lookup ask triggers one,
 *    and ordinary conversation still triggers nothing.
 *
 * 2. Quote-free grounding. The injected block is date-stamped in UTC and
 *    confines citations to the numbered sources; the reply's markers are
 *    audited against those sources and reported on meta.research.citations,
 *    so a fabricated [4] is a checkable field rather than a plausible-looking
 *    string in the output.
 *
 * Same boot pattern as the other research route tests: real express app,
 * in-memory memoryStore stand-in, stub Mistral, stub keyless provider, no
 * provider keys anywhere.
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
// Cites one real source and one that does not exist — the audit must split them.
const STUB_REPLY = 'Two events on the ridge, per [1]. A third is reported in [4].';

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
  duckRequests.push({ query: url.searchParams });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    Heading: '2026 Mid-Atlantic Ridge earthquakes',
    AbstractURL: 'https://example.com/mar-doublet',
    AbstractText: 'A magnitude 6.7 and a magnitude 6.8 earthquake struck the central Mid-Atlantic Ridge on 13 October 2026.',
    Results: [],
    RelatedTopics: []
  }));
});

// ---------- helpers / boot ----------

let server;
let port;

const todayUtc = () => new Date().toISOString().slice(0, 10);

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

function lastMistralPayload() {
  return mistralRequests[mistralRequests.length - 1].body;
}

before(async () => {
  await new Promise(resolve => mistralStub.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => duckStub.listen(0, '127.0.0.1', resolve));

  process.env.MISTRAL_API_KEY = 'route-test-key';
  process.env.MISTRAL_API_URL = `http://127.0.0.1:${mistralStub.address().port}/v1/chat/completions`;
  process.env.MISTRAL_MAX_RETRIES = '0';

  delete process.env.TAVILY_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.EXA_API_KEY;
  delete process.env.SERPER_API_KEY;

  process.env.DUCKDUCKGO_API_URL = `http://127.0.0.1:${duckStub.address().port}/`;
  process.env.RESEARCH_PROVIDERS = 'duckduckgo';
  process.env.RESEARCH_CACHE_TTL_MS = '0';

  // The mode under test.
  process.env.RESEARCH_AUTO_TRIGGER = 'true';

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

test('"research X" typed in the message triggers a lookup with no research field', async () => {
  mistralRequests.length = 0;
  duckRequests.length = 0;

  const message = 'research the two Atlantic ridge earthquakes that happened yesterday';
  const res = await request({ user_id: 'trigger-user', message });

  assert.equal(res.status, 200);
  assert.equal(res.body.meta.research.status, 'ok');
  assert.equal(res.body.meta.research.trigger, 'auto', 'the lookup was inferred from the message');
  assert.equal(duckRequests.length, 1, 'the inferred lookup actually ran');
  assert.equal(duckRequests[0].query.get('q'), message, 'the message is the query');

  // The injected block carries the retrieval and the date stamp the model
  // needs to resolve "yesterday" against today rather than its training data.
  const block = lastMistralPayload().messages.find(m => String(m.content).includes('<research_data>'));
  assert.ok(block, 'a research context block must be injected');
  assert.equal(block.role, 'system');
  assert.match(block.content, new RegExp(`Today is ${todayUtc()} \\(UTC\\)`));
  assert.match(block.content, /only material you may present as retrieved/);
  assert.match(block.content, /magnitude 6\.7 and a magnitude 6\.8/);

  // The audit splits the real citation from the invented one, and the
  // sanitizer removes the invented one from the reply the caller receives.
  assert.deepEqual(res.body.meta.research.citations, {
    sources: 1,
    used: [1],
    invalid: [4],
    uncited: false,
    stripped: [4]
  });
  assert.equal(
    res.body.response,
    'Two events on the ridge, per [1]. A third is reported in.',
    'the marker pointing at no source is gone from the returned reply'
  );

  // And from what was stored: the next turn must not be handed the fabricated
  // marker back as history.
  const stored = (chats.get('trigger-user|chat') || []).map(c => c.content);
  assert.ok(stored.some(c => c === res.body.response), 'the sanitized text is what gets stored');
  assert.ok(!stored.some(c => c.includes('[4]')), 'no fabricated marker survives into history');
});

test('a plainly time-sensitive question also triggers a lookup', async () => {
  duckRequests.length = 0;

  const res = await request({
    user_id: 'trigger-user',
    message: 'were there any earthquakes on the Mid-Atlantic Ridge in the past 30 days?'
  });

  assert.equal(res.body.meta.research.trigger, 'auto');
  assert.equal(duckRequests.length, 1);
});

test('ordinary chat still triggers nothing, even with the mode on', async () => {
  duckRequests.length = 0;

  const res = await request({ user_id: 'trigger-user', message: 'hey Jax, how was your day?' });

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), ['response'], 'no meta without a lookup');
  assert.equal(duckRequests.length, 0, 'no lookup for ordinary conversation');

  // Second shape of the same guarantee: a passing mention of "news" and
  // "today" is not a request to go and look something up.
  const chatter = await request({ user_id: 'trigger-user', message: 'I watched the news at the gym today' });
  assert.deepEqual(Object.keys(chatter.body), ['response']);
  assert.equal(duckRequests.length, 0);
});

test('an explicit research field is still reported as the explicit trigger', async () => {
  duckRequests.length = 0;

  const res = await request({ user_id: 'trigger-user', message: 'What is photosynthesis?', research: true });

  assert.equal(res.body.meta.research.trigger, 'explicit');
  assert.equal(duckRequests.length, 1);
});
