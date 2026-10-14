'use strict';

/*
 * Route-level tests for the NO-LOOKUP guard on POST /wrestling_chat.
 *
 * The failure notice (test/researchRoutes.test.js) covers a lookup that ran and
 * returned nothing. This file covers the path that produced the actual
 * incident: no lookup ran at all.
 *
 * Research is opt-in, so "research the two Atlantic ridge earthquakes" typed
 * into a chat box — an explicit request to a human reader, an ordinary string
 * to the API — reaches the model with no sources and, before this guard, no
 * instruction about sourcing either. The model then invents the archive sweep,
 * the negative result and the citation markers, and nothing anywhere reports a
 * failure, because nothing failed: nothing was attempted.
 *
 * The guard is on by default because it calls nothing. These tests boot the
 * REAL app in the default configuration — RESEARCH_AUTO_TRIGGER off (so no
 * lookup is ever attempted here), RESEARCH_NO_DATA_GUARD default — against an
 * in-memory memoryStore stand-in, a stub Mistral, and a stub provider that
 * must never be reached.
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
const STUB_REPLY = 'I have no live data access on this turn, but here is what I can tell you.';

const mistralStub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    mistralRequests.push({ body: JSON.parse(raw || '{}') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: STUB_REPLY } }] }));
  });
});

// ---------- stub provider (must never be called with the guard path) ----------

const duckRequests = [];

const duckStub = http.createServer((req, res) => {
  duckRequests.push({ url: req.url });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    Heading: 'Mid-Atlantic Ridge earthquake',
    AbstractURL: 'https://example.com/mid-atlantic-ridge-earthquake',
    AbstractText: 'The central Mid-Atlantic Ridge produced two earthquakes above magnitude 6.0 on 13 October 2026.',
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

function lastPayload() {
  return mistralRequests[mistralRequests.length - 1].body;
}

function noticeIn(payload) {
  return payload.messages.find(m => String(m.content).includes('No live lookup ran'));
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

  // Default configuration: no automatic triggering. Nothing here may start a
  // lookup, so the guard is the only thing standing between the model and an
  // improvised answer.
  process.env.RESEARCH_AUTO_TRIGGER = 'false';

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

test('a lookup-shaped message with no lookup runs gets told it has no retrieved material', async () => {
  mistralRequests.length = 0;
  duckRequests.length = 0;

  const res = await request({
    user_id: 'guard-user',
    message: 'research the two Atlantic ridge earthquakes that happened yesterday'
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.response, STUB_REPLY);
  // The response shape is untouched: the guard is prompt-level, not schema-level.
  assert.deepEqual(Object.keys(res.body), ['response'], 'no meta block is added');

  // Nothing was fetched — that is the whole point of this path...
  assert.equal(duckRequests.length, 0, 'no lookup is attempted with auto-trigger off');

  // ...so the model must be told, in the same turn, that it has no sources.
  const payload = lastPayload();
  const notice = noticeIn(payload);
  assert.ok(notice, 'the model must be told that no lookup ran');
  assert.equal(notice.role, 'system');
  assert.match(notice.content, new RegExp(`Today is ${todayUtc()} \\(UTC\\)`));
  assert.match(notice.content, /no live data access on this turn/i);
  assert.match(notice.content, /Cite nothing/i);
  assert.match(notice.content, /do not report a negative result/i);
  // The two closing moves from the incident: invented citations, and an
  // offer to monitor the ridge forever.
  assert.match(notice.content, /Never offer to monitor, watch, track, alert or notify/i);
  assert.match(notice.content, /does not restrict in-character conversation/i);
  assert.equal(payload.max_tokens, 800, 'the honest reply needs room, not the 250 chat default');
});

test('a plainly time-sensitive question gets the same guard', async () => {
  mistralRequests.length = 0;

  const res = await request({
    user_id: 'guard-user',
    message: 'were there any earthquakes on the Mid-Atlantic Ridge in the last 24 hours?'
  });

  assert.equal(res.status, 200);
  assert.ok(noticeIn(lastPayload()), 'a time-sensitive question is a lookup ask');
});

test('ordinary conversation gets no notice, no lookup, and the plain token cap', async () => {
  mistralRequests.length = 0;
  duckRequests.length = 0;

  const res = await request({ user_id: 'guard-user', message: 'hey Jax, how are you doing?' });

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), ['response']);
  const payload = lastPayload();
  assert.equal(noticeIn(payload), undefined, 'normal chat must not be told about lookups it never asked for');
  assert.equal(payload.max_tokens, 250, 'the chat default is untouched');
  assert.equal(duckRequests.length, 0);
});

test('when research does run, the sourced block replaces the guard', async () => {
  mistralRequests.length = 0;
  duckRequests.length = 0;

  const res = await request({
    user_id: 'guard-user',
    message: 'research the two Atlantic ridge earthquakes',
    research: true
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.meta.research.status, 'ok');
  assert.equal(duckRequests.length, 1, 'the explicit flag still triggers a real lookup');

  const payload = lastPayload();
  assert.equal(noticeIn(payload), undefined, 'a recovered source block is not accompanied by the no-data notice');
  const block = payload.messages.find(m => String(m.content).includes('<research_data>'));
  assert.ok(block, 'the retrieved sources are what the model is given');
});

test('the guard tells the model not to recycle its own earlier turns', async () => {
  mistralRequests.length = 0;

  // The compounding case: the model's own unverified claims from earlier turns
  // come back as history and get restated as fact. The notice must close that
  // loop as well as the "no retrieval" one.
  await request({
    user_id: 'guard-user',
    message: 'list all Mid-Atlantic Ridge earthquakes in the last 30 days'
  });

  const notice = noticeIn(lastPayload());
  assert.ok(notice);
  assert.match(notice.content, /Earlier turns in this conversation are not a source/);
});

test('the research notice is the LAST message, not buried above the history', async () => {
  mistralRequests.length = 0;

  // Seed a few turns so there is a real history for the notice to sit behind.
  await request({ user_id: 'guard-user', message: 'hey Jax' });
  await request({ user_id: 'guard-user', message: 'how is it going?' });
  mistralRequests.length = 0;

  await request({ user_id: 'guard-user', message: 'what is the latest on the ridge?' });

  const payload = lastPayload();
  const last = payload.messages[payload.messages.length - 1];
  assert.ok(
    String(last.content).includes('No live lookup ran'),
    'the constraint must be the last thing the model reads, not the first'
  );
  assert.ok(
    payload.messages.length > 2,
    'and there must actually be history in front of it for this to mean anything'
  );
});
