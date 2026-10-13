'use strict';

/*
 * Route-level tests for Tier 2 (structured data + analysis) on
 * POST /wrestling_chat. Boots the real express app against the in-memory
 * memoryStore stand-in, a stub Mistral API, and a stub World Bank API, and
 * pins the Tier 2 guarantees:
 *
 *   • no `analysis` field → old behavior, data provider never called
 *   • analysis + worldbank dataset → numbers computed locally reach the
 *     model inside <analysis_data>, the full computed summary comes back in
 *     meta.analysis, and only that call gets the raised token cap
 *   • analysis + inline rows → same, with zero network calls
 *   • provider outage / missing dataset → fail-open 200, meta reports it
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('module');

// ---------- in-memory memoryStore stand-in ----------

const chats = new Map();
const facts = new Map();

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
  async getCharacterFacts(userId, scope) {
    return facts.get(scopeKey(userId, scope)) || '';
  },
  async updateCharacterFacts(userId, nextFacts, scope) {
    facts.set(scopeKey(userId, scope), nextFacts);
  }
};

// ---------- stub Mistral ----------

const mistralRequests = [];
const STUB_REPLY = 'Here is the breakdown.';

const mistralStub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    mistralRequests.push({ body: JSON.parse(raw || '{}') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: STUB_REPLY } }] }));
  });
});

// ---------- stub World Bank ----------

const wbRequests = [];
let wbStatus = 200;

const wbStub = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  wbRequests.push({ path: url.pathname, query: url.searchParams });
  res.writeHead(wbStatus, { 'Content-Type': 'application/json' });
  if (wbStatus === 200) {
    // GDP-ish series for Canada: 100 → 120 → 150 (plus one null year).
    res.end(JSON.stringify([
      { page: 1, pages: 1, per_page: '20000', total: 4 },
      [
        { country: { id: 'CA', value: 'Canada' }, indicator: { id: 'NY.GDP.MKTP.CD', value: 'GDP (current US$)' }, date: '2023', value: 150 },
        { country: { id: 'CA', value: 'Canada' }, indicator: { id: 'NY.GDP.MKTP.CD', value: 'GDP (current US$)' }, date: '2022', value: null },
        { country: { id: 'CA', value: 'Canada' }, indicator: { id: 'NY.GDP.MKTP.CD', value: 'GDP (current US$)' }, date: '2021', value: 120 },
        { country: { id: 'CA', value: 'Canada' }, indicator: { id: 'NY.GDP.MKTP.CD', value: 'GDP (current US$)' }, date: '2020', value: 100 }
      ]
    ]));
  } else {
    res.end(JSON.stringify({ message: 'provider unavailable' }));
  }
});

// ---------- boot / helpers ----------

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
  await new Promise(resolve => wbStub.listen(0, '127.0.0.1', resolve));

  process.env.MISTRAL_API_KEY = 'route-test-key';
  process.env.MISTRAL_API_URL = `http://127.0.0.1:${mistralStub.address().port}/v1/chat/completions`;
  process.env.MISTRAL_MAX_RETRIES = '0';
  process.env.WORLDBANK_API_URL = `http://127.0.0.1:${wbStub.address().port}`;
  // Point the keyless Tier 1 provider at the stub too, so the compose test
  // never reaches the real network (its payload just yields no DDG results).
  process.env.DUCKDUCKGO_API_URL = `http://127.0.0.1:${wbStub.address().port}/`;
  process.env.DATA_CACHE_TTL_MS = '0';

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
  await new Promise(resolve => wbStub.close(resolve));
});

// ---------- tests ----------

test('without an analysis flag the data provider is never called', async () => {
  mistralRequests.length = 0;
  wbRequests.length = 0;

  const res = await request({ user_id: 'plain-user', message: 'yo Jax' });

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), ['response']);
  assert.equal(wbRequests.length, 0);
  const payload = mistralRequests[mistralRequests.length - 1].body;
  assert.equal(payload.max_tokens, 250);
  assert.ok(!payload.messages.some(m => String(m.content).includes('<analysis_data>')));
});

test('worldbank analysis returns exact computed numbers in meta and context', async () => {
  mistralRequests.length = 0;
  wbRequests.length = 0;

  const res = await request({
    user_id: 'analysis-user',
    message: 'How has Canada GDP trended?',
    analysis: true,
    dataset: { provider: 'worldbank', country: 'CAN', indicator: 'NY.GDP.MKTP.CD' }
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.response, STUB_REPLY);
  assert.equal(wbRequests.length, 1);
  assert.equal(wbRequests[0].path, '/country/CAN/indicator/NY.GDP.MKTP.CD');

  const meta = res.body.meta.analysis;
  assert.equal(meta.status, 'ok');
  assert.equal(meta.dataset.provider, 'worldbank');
  assert.equal(meta.dataset.rowCount, 3, 'the null year is dropped');

  // The engine — not the model — did this math: 100, 120, 150.
  const value = meta.summary.fields.value;
  assert.equal(value.mean, 123.333);
  assert.equal(value.median, 120);
  assert.equal(meta.summary.trend.change, 50);
  assert.equal(meta.summary.trend.percentChange, 50);
  assert.equal(meta.summary.trend.direction, 'increasing');
  assert.deepEqual(
    meta.summary.trend.series,
    [{ x: 2020, y: 100 }, { x: 2021, y: 120 }, { x: 2023, y: 150 }]
  );

  // The model saw exactly one analysis block carrying those numbers, with
  // the raised token cap — and stored facts gained none of it.
  const payload = mistralRequests[mistralRequests.length - 1].body;
  assert.equal(payload.max_tokens, 800);
  const blocks = payload.messages.filter(m => String(m.content).includes('<analysis_data>'));
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].content, /change=50 \(50%\)/);
  assert.match(blocks[0].content, /Do not recalculate/);
  assert.ok(!(facts.get('analysis-user|chat') || '').includes('GDP'));
});

test('inline rows are analyzed with zero network calls', async () => {
  wbRequests.length = 0;

  const res = await request({
    user_id: 'analysis-user',
    message: 'Analyze my numbers',
    analysis: true,
    data: [
      { month: 1, sales: 10 },
      { month: 2, sales: 20 },
      { month: 3, sales: 30 }
    ],
    analysis_x: 'month',
    analysis_y: 'sales'
  });

  assert.equal(res.status, 200);
  assert.equal(wbRequests.length, 0, 'inline data must not hit any provider');
  const meta = res.body.meta.analysis;
  assert.equal(meta.dataset.provider, 'inline');
  assert.equal(meta.summary.fields.sales.mean, 20);
  assert.equal(meta.summary.trend.slopePerUnit, 10);
  assert.equal(meta.summary.trend.rSquared, 1);
});

test('flat shorthand fields build a worldbank spec', async () => {
  wbRequests.length = 0;

  const res = await request({
    user_id: 'analysis-user',
    message: 'GDP?',
    analysis: true,
    data_provider: 'worldbank',
    country: 'CAN',
    indicator: 'NY.GDP.MKTP.CD'
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.meta.analysis.status, 'ok');
  assert.equal(wbRequests.length, 1);
});

test('research and analysis compose in one request, each with its own meta', async () => {
  const res = await request({
    user_id: 'analysis-user',
    message: 'Combine both',
    research: true,
    research_provider: 'duckduckgo',
    analysis: true,
    data: [{ v: 1 }, { v: 2 }, { v: 3 }]
  });

  assert.equal(res.status, 200);
  // No DuckDuckGo stub is configured in this file, so Tier 1 may fail open —
  // what matters is both blocks are present and independent.
  assert.ok(res.body.meta.research, 'meta.research present');
  assert.ok(res.body.meta.analysis, 'meta.analysis present');
  assert.equal(res.body.meta.analysis.status, 'ok');
  assert.equal(res.body.meta.analysis.summary.fields.v.mean, 2);
});

test('a data provider outage fails open with meta.analysis.status = error', async () => {
  mistralRequests.length = 0;
  wbStatus = 503;
  try {
    const res = await request({
      user_id: 'analysis-user',
      message: 'GDP?',
      analysis: true,
      dataset: { provider: 'worldbank', country: 'CAN', indicator: 'NY.GDP.MKTP.CD' }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.response, STUB_REPLY);
    assert.equal(res.body.meta.analysis.status, 'error');
    assert.match(res.body.meta.analysis.error, /503/);

    const payload = mistralRequests[mistralRequests.length - 1].body;
    assert.equal(payload.max_tokens, 250, 'no context injected, default cap applies');
    assert.ok(!payload.messages.some(m => String(m.content).includes('<analysis_data>')));
  } finally {
    wbStatus = 200;
  }
});

test('analysis with no dataset is unavailable, never a 500 and never a guess', async () => {
  wbRequests.length = 0;

  const res = await request({
    user_id: 'analysis-user',
    message: 'Analyze something',
    analysis: true
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.meta.analysis.status, 'unavailable');
  assert.match(res.body.meta.analysis.error, /requires a dataset/);
  assert.equal(wbRequests.length, 0);
});
