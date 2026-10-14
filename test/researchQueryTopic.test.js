'use strict';

/*
 * Route-level tests for research query construction.
 *
 * The failure these pin down, verbatim from a live answer: asked about
 * Mid-Atlantic Ridge earthquakes, the user replied "ok" — and the whole
 * message then went to the provider as the search query. Searching "ok"
 * returns the history of the word, Katy Perry and celebrity gossip, so the
 * model was handed a stack of pages about the word "OK" and correctly
 * reported that none of them contained seismic data. Honest, and useless.
 *
 * The rule: a lookup query has to name a topic. A thin follow-up inherits the
 * topic from the most recent substantive user turn; if there is nothing to
 * inherit, no lookup runs at all and the reply says so.
 *
 * Boots the REAL app with RESEARCH_AUTO_TRIGGER off and explicit
 * research: true on each request, against an in-memory memoryStore stand-in
 * and a stub provider that records every query it is sent.
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
const STUB_REPLY = 'Answer.';

const mistralStub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    mistralRequests.push({ body: JSON.parse(raw || '{}') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: STUB_REPLY } }] }));
  });
});

// ---------- stub provider (records the query it receives) ----------

const providerQueries = [];

const providerStub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    // Keyed providers POST a JSON body; the keyless ones GET with params.
    let query = '';
    const url = new URL(req.url, 'http://127.0.0.1');
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        query = parsed.query || parsed.q || '';
      } catch {
        query = '';
      }
    }
    if (!query) query = url.searchParams.get('q') || url.searchParams.get('search') || '';
    providerQueries.push({ query, url: url.toString() });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // One payload that satisfies both adapters: `results` for the web-search
    // shape, `features` for the USGS catalog shape (a seismic query reaches
    // the catalog, a general one reaches web search).
    res.end(JSON.stringify({
      results: [{ title: 'Atlantic ridge quakes', url: 'https://example.com/ridge', content: 'Magnitude 6.8 on the central Mid-Atlantic Ridge.' }],
      metadata: { count: 1, url: 'https://earthquake.usgs.gov/fdsnws/event/1/query?stub=1' },
      features: [{
        type: 'Feature',
        properties: {
          mag: 6.8, place: 'central Mid-Atlantic Ridge', time: 1791894187248,
          url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us6000u214',
          title: 'M 6.8 - central Mid-Atlantic Ridge', magType: 'mww', status: 'reviewed'
        },
        geometry: { type: 'Point', coordinates: [-19.4308, -0.4085, 10] }
      }]
    }));
  });
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
  await new Promise(resolve => providerStub.listen(0, '127.0.0.1', resolve));

  process.env.MISTRAL_API_KEY = 'route-test-key';
  process.env.MISTRAL_API_URL = `http://127.0.0.1:${mistralStub.address().port}/v1/chat/completions`;
  process.env.MISTRAL_MAX_RETRIES = '0';
  process.env.TAVILY_API_KEY = 'route-research-key';
  process.env.TAVILY_API_URL = `http://127.0.0.1:${providerStub.address().port}/search`;
  delete process.env.DUCKDUCKGO_WEB_API_URL;
  delete process.env.BING_WEB_API_URL;
  delete process.env.DUCKDUCKGO_API_URL;
  delete process.env.WIKIPEDIA_API_URL;
  delete process.env.OPENALEX_API_URL;
  process.env.USGS_API_URL = `http://127.0.0.1:${providerStub.address().port}/fdsnws`;
  process.env.RESEARCH_CACHE_TTL_MS = '0';
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
  await new Promise(resolve => providerStub.close(resolve));
});

// ---------- tests ----------

test('a thin follow-up inherits the topic instead of searching "ok"', async () => {
  providerQueries.length = 0;

  // Turn 1: the actual question. Turn 2: the actual word that broke it.
  await request({
    user_id: 'topic-user',
    message: 'were there any earthquakes on the Mid-Atlantic Ridge yesterday?'
  });
  const res = await request({ user_id: 'topic-user', message: 'ok', research: true });

  assert.equal(res.status, 200);
  assert.equal(res.body.meta.research.status, 'ok');
  assert.notEqual(providerQueries[providerQueries.length - 1].query, 'ok', '"ok" must never be the query');
  assert.match(
    res.body.meta.research.query,
    /earthquakes on the Mid-Atlantic Ridge yesterday/,
    'the inherited topic is what gets searched'
  );

  // And the model is given sources about the ridge, not about the word.
  const block = mistralRequests[mistralRequests.length - 1].body.messages.find(m => String(m.content).includes('<research_data>'));
  assert.ok(block);
  assert.match(block.content, /central Mid-Atlantic Ridge/);
});

test('an explicit research_query is honoured, but inherits the topic when it is thin', async () => {
  providerQueries.length = 0;

  // A substantive explicit query is used verbatim.
  await request({
    user_id: 'query-user',
    message: 'tell me more',
    research: true,
    research_query: 'lithium iron phosphate pack prices 2026'
  });
  assert.equal(providerQueries[providerQueries.length - 1].query, 'lithium iron phosphate pack prices 2026');

  // A thin one (the caller passed along a follow-up) is not searched verbatim.
  await request({ user_id: 'query-user', message: 'and the volcanoes?' });
  await request({ user_id: 'query-user', message: 'more', research: true, research_query: 'more' });
  assert.notEqual(providerQueries[providerQueries.length - 1].query, 'more');
  assert.equal(providerQueries[providerQueries.length - 1].query, 'and the volcanoes?');
});

test('with no topic anywhere in the conversation, no lookup runs and the reply is told so', async () => {
  providerQueries.length = 0;
  mistralRequests.length = 0;

  const res = await request({ user_id: 'cold-user', message: 'ok', research: true });

  assert.equal(res.status, 200, 'still fail-open, never a 500');
  assert.equal(providerQueries.length, 0, 'nothing was searched');
  assert.equal(res.body.meta.research.status, 'unavailable');
  assert.match(res.body.meta.research.error, /short follow-up/);

  // The model is told the lookup could not be formed, so it says so rather
  // than answering the word "ok" from memory.
  const notice = mistralRequests[mistralRequests.length - 1].body.messages.find(m => String(m.content).includes('the lookup FAILED'));
  assert.ok(notice, 'the failure notice is injected');
  assert.match(notice.content, /short follow-up/);
});

test('a caller-supplied fragment of the message is ignored in favour of the message', async () => {
  providerQueries.length = 0;

  const message = 'research the two Atlantic ridge earthquakes that happened yesterday';
  // The reported client behaviour: only a word or two reaches research_query.
  for (const fragment of ['research', 'Atlantic', 'the two Atlantic']) {
    const res = await request({
      user_id: 'fragment-user',
      message,
      research: true,
      research_query: fragment
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.meta.research.query, message, `fragment ${JSON.stringify(fragment)} must not become the query`);
  }
});

test('a substantive message is still used verbatim', async () => {
  providerQueries.length = 0;

  const res = await request({
    user_id: 'topic-user',
    message: 'list all Ridgecrest earthquakes in the last 90 days',
    research: true
  });

  assert.equal(res.body.meta.research.query, 'list all Ridgecrest earthquakes in the last 90 days');
  assert.equal(providerQueries.length, 1, 'the query reached a provider');
  assert.equal(res.body.meta.research.provider, 'usgs', 'a seismic query goes to the catalog');
  // And the catalog parameters are derived from that message: a 90-day window.
  const hours = (Date.parse(new URL(providerQueries[0].url).searchParams.get('endtime'))
    - Date.parse(new URL(providerQueries[0].url).searchParams.get('starttime'))) / 3600000;
  assert.ok(Math.abs(hours - 2160) < 1, `window should be 90 days, got ${hours} hours`);
});
