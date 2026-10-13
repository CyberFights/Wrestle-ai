'use strict';

/*
 * Route-level tests for Tier 3 (predictive modeling) on POST /wrestling_chat.
 * Real express app + in-memory memoryStore + stub Mistral + stub World Bank.
 *
 * Pins the Tier 3 guarantees:
 *   • no flag            → data provider never called, { response } only
 *   • prediction: true   → local forecast in meta.prediction with points and
 *                          intervals; model gets a <forecast_data> block and
 *                          the raised token cap for that call only
 *   • too little data    → 200 with meta.prediction.status='insufficient'
 *                          and a refusal block telling the model not to guess
 *   • prediction implies the Tier 2 dataset fetch but NOT meta.analysis
 *     unless analysis was also requested (then both appear, one fetch)
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
const STUB_REPLY = 'Here is the outlook.';

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
// Perfect ramp 2016–2023: value = 100 + 10·(year−2016). Next: 2024→180.

const wbRequests = [];
let wbStatus = 200;

const wbStub = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  wbRequests.push({ path: url.pathname, query: url.searchParams });
  res.writeHead(wbStatus, { 'Content-Type': 'application/json' });
  if (wbStatus === 200) {
    const entries = [];
    for (let year = 2023; year >= 2016; year -= 1) {
      entries.push({
        country: { id: 'CA', value: 'Canada' },
        indicator: { id: 'NY.GDP.MKTP.CD', value: 'GDP (current US$)' },
        date: String(year),
        value: 100 + 10 * (year - 2016)
      });
    }
    res.end(JSON.stringify([{ page: 1, pages: 1, per_page: '20000', total: entries.length }, entries]));
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

test('without a prediction flag nothing is fetched or forecast', async () => {
  mistralRequests.length = 0;
  wbRequests.length = 0;

  const res = await request({ user_id: 'plain-user', message: 'yo Jax' });

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), ['response']);
  assert.equal(wbRequests.length, 0);
  const payload = mistralRequests[mistralRequests.length - 1].body;
  assert.equal(payload.max_tokens, 250);
  assert.ok(!payload.messages.some(m => String(m.content).includes('<forecast_data>')));
});

test('prediction over World Bank data returns exact extrapolated points', async () => {
  mistralRequests.length = 0;
  wbRequests.length = 0;

  const res = await request({
    user_id: 'predict-user',
    message: 'Where is Canada GDP heading?',
    prediction: true,
    dataset: { provider: 'worldbank', country: 'CAN', indicator: 'NY.GDP.MKTP.CD' },
    forecast_method: 'linear',
    forecast_horizon: 3
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.response, STUB_REPLY);
  assert.equal(wbRequests.length, 1, 'one dataset fetch serves the forecast');

  const meta = res.body.meta.prediction;
  assert.equal(meta.status, 'ok');
  assert.equal(meta.dataset.provider, 'worldbank');
  assert.equal(meta.forecast.method, 'linear');
  assert.equal(meta.forecast.trainedOn.points, 8);
  assert.deepEqual(meta.forecast.points.map(p => p.x), [2024, 2025, 2026]);
  assert.deepEqual(meta.forecast.points.map(p => p.estimate), [180, 190, 200]);
  assert.equal(meta.forecast.simulations, 1000);
  assert.equal(meta.forecast.seed, 42);

  // Prediction implied the dataset/analysis pipeline internally, but
  // meta.analysis only appears when analysis was actually requested.
  assert.equal(res.body.meta.analysis, undefined);

  // The model received the forecast block (with the exact points) and the
  // raised token cap; nothing leaked into stored character facts.
  const payload = mistralRequests[mistralRequests.length - 1].body;
  assert.equal(payload.max_tokens, 800);
  const blocks = payload.messages.filter(m => String(m.content).includes('<forecast_data>'));
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].content, /2024: estimate=180/);
  assert.match(blocks[0].content, /never as a certainty/);
  assert.ok(!(facts.get('predict-user|chat') || '').includes('GDP'));
});

test('analysis + prediction compose: both metas, one fetch, consistent context', async () => {
  wbRequests.length = 0;
  mistralRequests.length = 0;

  const res = await request({
    user_id: 'predict-user',
    message: 'Analyze and forecast',
    analysis: true,
    prediction: true,
    dataset: { provider: 'worldbank', country: 'CAN', indicator: 'NY.GDP.MKTP.CD' },
    forecast_method: 'linear',
    forecast_horizon: 2
  });

  assert.equal(res.status, 200);
  assert.equal(wbRequests.length, 1, 'the dataset is fetched once for both tiers');
  assert.equal(res.body.meta.analysis.status, 'ok');
  assert.equal(res.body.meta.prediction.status, 'ok');
  assert.deepEqual(res.body.meta.prediction.forecast.points.map(p => p.estimate), [180, 190]);

  // The Tier 2 block must not contradict Tier 3 by claiming no forecast exists.
  const payload = mistralRequests[mistralRequests.length - 1].body;
  const analysisBlock = payload.messages.find(m => String(m.content).includes('<analysis_data>'));
  assert.ok(analysisBlock);
  assert.doesNotMatch(analysisBlock.content, /none was computed/);
  assert.match(analysisBlock.content, /forecast was also computed/i);
});

test('too little data returns insufficient, and the model is told not to guess', async () => {
  mistralRequests.length = 0;

  const res = await request({
    user_id: 'predict-user',
    message: 'Predict from almost nothing',
    prediction: true,
    data: [
      { year: 2022, value: 10 },
      { year: 2023, value: 12 },
      { year: 2024, value: 11 }
    ]
  });

  assert.equal(res.status, 200, 'insufficient data is not a server error');
  assert.equal(res.body.meta.prediction.status, 'insufficient');
  assert.ok(res.body.meta.prediction.reasons.some(r => /at least 5/.test(r)));
  assert.equal(res.body.meta.prediction.forecast, undefined, 'no forecast numbers may be returned');

  const payload = mistralRequests[mistralRequests.length - 1].body;
  assert.equal(payload.max_tokens, 800, 'the model still needs room to explain');
  const block = payload.messages.find(m => String(m.content).includes('<forecast_data>'));
  assert.ok(block, 'a refusal block must be injected');
  assert.match(block.content, /NO forecast was computed/);
  assert.match(block.content, /Do NOT invent/);
});

test('prediction with no dataset is unavailable, never a 500', async () => {
  wbRequests.length = 0;

  const res = await request({
    user_id: 'predict-user',
    message: 'Predict something',
    prediction: true
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.meta.prediction.status, 'unavailable');
  assert.match(res.body.meta.prediction.error, /requires a dataset/);
  assert.equal(wbRequests.length, 0);
});

test('the forecast alias and threshold probability work end to end', async () => {
  const res = await request({
    user_id: 'predict-user',
    message: 'Will it pass 185 soon?',
    forecast: true, // alias of prediction
    data: Array.from({ length: 8 }, (_, i) => ({ year: 2016 + i, value: 100 + 10 * i })),
    forecast_method: 'linear',
    forecast_horizon: 2,
    forecast_threshold: 185
  });

  assert.equal(res.status, 200);
  const meta = res.body.meta.prediction;
  assert.equal(meta.status, 'ok');
  // Final point (2025 → 190) on a perfect ramp is certainly above 185.
  assert.equal(meta.forecast.threshold.atX, 2025);
  assert.equal(meta.forecast.threshold.probabilityAbove, 1);
});

test('a data provider outage reports on meta.prediction as error', async () => {
  wbStatus = 503;
  try {
    const res = await request({
      user_id: 'predict-user',
      message: 'GDP forecast?',
      prediction: true,
      dataset: { provider: 'worldbank', country: 'CAN', indicator: 'NY.GDP.MKTP.CD' }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.meta.prediction.status, 'error');
    assert.match(res.body.meta.prediction.error, /503/);
  } finally {
    wbStatus = 200;
  }
});
