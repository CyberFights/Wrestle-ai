'use strict';

/*
 * RESEARCH_NO_DATA_GUARD=false must restore the previous prompt exactly.
 *
 * The guard is on by default because it behaves well, but it is a behaviour
 * change for existing callers — a chat reply to a time-sensitive question now
 * says "I have no live data access" instead of answering from memory — so an
 * operator has to be able to turn it off. This file boots the REAL app with
 * the guard off and asserts the model is reached with nothing extra: same
 * messages, same 250-token cap, no notice.
 *
 * (Its own file because the switch is read when wrestling.js is first
 * required, and `node --test` gives every test file its own process.)
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('module');

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

const mistralRequests = [];
const STUB_REPLY = 'Reply from memory, guard disabled.';

const mistralStub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    mistralRequests.push({ body: JSON.parse(raw || '{}') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: STUB_REPLY } }] }));
  });
});

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

  process.env.MISTRAL_API_KEY = 'route-test-key';
  process.env.MISTRAL_API_URL = `http://127.0.0.1:${mistralStub.address().port}/v1/chat/completions`;
  process.env.MISTRAL_MAX_RETRIES = '0';
  delete process.env.TAVILY_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.EXA_API_KEY;
  delete process.env.SERPER_API_KEY;
  process.env.RESEARCH_AUTO_TRIGGER = 'false';
  process.env.RESEARCH_NO_DATA_GUARD = 'false';

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
});

test('RESEARCH_NO_DATA_GUARD=false leaves the prompt untouched', async () => {
  mistralRequests.length = 0;

  const res = await request({
    user_id: 'guard-off-user',
    message: 'research the two Atlantic ridge earthquakes that happened yesterday'
  });

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), ['response']);

  const payload = mistralRequests[mistralRequests.length - 1].body;
  assert.equal(
    payload.messages.find(m => String(m.content).includes('No live lookup ran')),
    undefined,
    'the guard is off, so no notice is injected'
  );
  assert.equal(payload.max_tokens, 250, 'and the chat token default applies');
});
