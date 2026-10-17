'use strict';

/*
 * Route-level tests for POST /personality_profile and the GET companions.
 * Stubs memoryStore and the Mistral API the same way wrestlingRoutes.test.js does.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('module');

const PORT = 18992;
const API_KEY = 'profile-test-key';

const profiles = new Map(); // `${userId}|${personKey}` → record
const chats = new Map(); // userId → [{ role, content }]

function personKey(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

const fakeMemoryStore = {
  MODEL_HISTORY_LIMIT: 10,
  async initDb() {},
  async storeMessage(userId, message, role) {
    const id = String(userId);
    if (!chats.has(id)) chats.set(id, []);
    chats.get(id).push({ role, content: message });
  },
  async getLastMessages(userId, limit = 10) {
    return (chats.get(String(userId)) || []).slice(-limit).map(m => ({ ...m }));
  },
  async getCharacterFacts() { return ''; },
  async updateCharacterFacts() {},
  async savePersonProfile(userId, personName, record) {
    const key = personKey(personName);
    const now = new Date();
    const id = `${userId}|${key}`;
    const prev = profiles.get(id);
    const revisions = Array.isArray(prev && prev.revisions) ? prev.revisions.slice() : [];
    if (prev) {
      revisions.push({
        saved_at: prev.updated_at,
        profile: prev.profile,
        memories: prev.memories,
        system_prompt: prev.system_prompt
      });
    }
    const doc = {
      _id: key,
      user_id: String(userId),
      person_key: key,
      person_name: String(personName),
      profile: record.profile,
      memories: record.memories || (record.profile && record.profile.memories) || [],
      system_prompt: record.system_prompt,
      sources: record.sources || [],
      source_archive: record.documents || record.source_archive || (prev && prev.source_archive) || [],
      revisions,
      consent: Object.prototype.hasOwnProperty.call(record || {}, 'consent') ? record.consent : (prev && prev.consent),
      created_at: prev ? prev.created_at : now,
      updated_at: now
    };
    profiles.set(id, doc);
    return doc;
  },
  async getPersonProfile(userId, personName) {
    return profiles.get(`${userId}|${personKey(personName)}`) || null;
  },
  async patchPersonProfile(userId, personName, patch = {}) {
    const existing = await fakeMemoryStore.getPersonProfile(userId, personName);
    if (!existing) return null;
    return fakeMemoryStore.savePersonProfile(userId, existing.person_name, {
      profile: { ...(existing.profile || {}), ...(patch.profile || {}) },
      memories: patch.memories != null ? patch.memories : existing.memories,
      system_prompt: patch.system_prompt != null ? patch.system_prompt : existing.system_prompt,
      sources: existing.sources,
      consent: patch.consent !== undefined ? patch.consent : existing.consent
    });
  },
  async deletePersonProfile(userId, personName) {
    const id = `${userId}|${personKey(personName)}`;
    if (!profiles.has(id)) return false;
    profiles.delete(id);
    return true;
  },
  async patchPersonMemory(userId, personName, memoryId, patch = {}) {
    const existing = await fakeMemoryStore.getPersonProfile(userId, personName);
    if (!existing) return null;
    const memories = (existing.memories || []).slice();
    const index = memories.findIndex(mem => mem && String(mem.id) === String(memoryId));
    if (index < 0) return null;
    memories[index] = { ...memories[index], ...patch, id: memories[index].id };
    await fakeMemoryStore.savePersonProfile(userId, existing.person_name, {
      profile: { ...existing.profile, memories },
      memories,
      system_prompt: existing.system_prompt,
      sources: existing.sources,
      consent: existing.consent
    });
    return memories[index];
  },
  async deletePersonMemory(userId, personName, memoryId) {
    const existing = await fakeMemoryStore.getPersonProfile(userId, personName);
    if (!existing) return null;
    const memories = (existing.memories || []).filter(mem => mem && String(mem.id) !== String(memoryId));
    if (memories.length === (existing.memories || []).length) return null;
    return fakeMemoryStore.savePersonProfile(userId, existing.person_name, {
      profile: { ...existing.profile, memories },
      memories,
      system_prompt: existing.system_prompt,
      sources: existing.sources,
      consent: existing.consent
    });
  },
  async restorePersonProfileRevision(userId, personName, index) {
    const existing = await fakeMemoryStore.getPersonProfile(userId, personName);
    if (!existing || !existing.revisions || !existing.revisions[Number(index)]) return null;
    const rev = existing.revisions[Number(index)];
    return fakeMemoryStore.savePersonProfile(userId, existing.person_name, {
      profile: rev.profile,
      memories: rev.memories,
      system_prompt: rev.system_prompt,
      sources: existing.sources,
      consent: existing.consent
    });
  },
  async listPersonProfiles(userId) {
    const rows = [];
    for (const doc of profiles.values()) {
      if (doc.user_id === String(userId)) {
        rows.push({
          person_name: doc.person_name,
          person_key: doc.person_key,
          summary: doc.profile && doc.profile.summary,
          memory_count: Array.isArray(doc.memories) ? doc.memories.length : 0,
          created_at: doc.created_at,
          updated_at: doc.updated_at
        });
      }
    }
    return rows;
  }
};

const mistralRequests = [];
let stubReply = JSON.stringify({
  person_name: 'Mara Quinn',
  summary: 'A private, sharp-tongued diarist who trusts slowly.',
  personality_traits: [{ trait: 'guarded', description: 'keeps people at arm\'s length', evidence: 'I did not tell them', confidence: 'high' }],
  characteristics: [{ label: 'night writer', evidence: 'every entry after midnight' }],
  mindsets: [{ label: 'self-reliant', description: 'asks for nothing' }],
  psychological_indicators: [{ label: 'persistent insomnia', evidence: 'cannot sleep', confidence: 'medium', not_a_diagnosis: true }],
  speech_patterns: {
    overview: 'Short clauses. Then a longer sentence when angry.',
    tone: 'dry',
    catchphrases: ['figure it out'],
    example_lines: ['I already said no.']
  },
  ideologies: [{ label: 'self-reliance' }],
  values: ['loyalty'],
  fears: ['being a burden'],
  motivations: ['finish the book'],
  relationships: [{ name: 'Dad', nature: 'estranged' }],
  biography_notes: ['grew up by the lake'],
  memories: [{
    type: 'event',
    title: 'Dad stopped calling',
    content: 'He stopped calling after the funeral.',
    who: ['Dad'],
    importance: 'high',
    evidence: 'I did not tell Dad.'
  }],
  system_prompt: 'You are Mara Quinn. Stay in character at all times. Speak exclusively in first person as Mara Quinn. Short clauses. Dry tone. You do not ask for help. Loyalty matters more than comfort.'
});

const mistralStub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    mistralRequests.push(JSON.parse(raw || '{}'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: stubReply } }] }));
  });
});

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        method,
        headers: { 'Content-Type': 'application/json' }
      },
      res => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch (err) { /* leave null */ }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.end(body == null ? undefined : JSON.stringify(body));
  });
}

function requestMultipart(path, fields, files) {
  const boundary = '----profiletestboundary';
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  for (const file of files) {
    chunks.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`
    );
    chunks.push(file.body);
    chunks.push('\r\n');
  }
  chunks.push(`--${boundary}--\r\n`);
  const body = Buffer.concat(chunks.map(part => Buffer.isBuffer(part) ? part : Buffer.from(part)));

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length
        }
      },
      res => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch (err) { /* leave null */ }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

let server;

before(async () => {
  await new Promise(resolve => mistralStub.listen(0, '127.0.0.1', resolve));

  process.env.MISTRAL_API_KEY = API_KEY;
  process.env.MISTRAL_API_URL = `http://127.0.0.1:${mistralStub.address().port}/v1/chat/completions`;
  process.env.MISTRAL_MAX_RETRIES = '0';

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

test('POST /personality_profile requires user_id and a document', async () => {
  const missingUser = await request('POST', '/personality_profile', { document: 'hello' });
  assert.equal(missingUser.status, 400);
  assert.match(missingUser.body.error, /user_id/);

  const missingDoc = await request('POST', '/personality_profile', { user_id: 'u1', person_name: 'Mara' });
  assert.equal(missingDoc.status, 400);
  assert.match(missingDoc.body.error, /document/i);
});

test('POST /personality_profile analyzes text and saves under the person\'s name', async () => {
  mistralRequests.length = 0;
  const res = await request('POST', '/personality_profile', {
    user_id: 'u1',
    person_name: 'Mara Quinn',
    document: 'Day 12. I cannot sleep. I already said no. Figure it out. I did not tell Dad.'
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.person_name, 'Mara Quinn');
  assert.equal(res.body.person_key, 'mara_quinn');
  assert.equal(res.body.profile.psychological_indicators[0].not_a_diagnosis, true);
  assert.match(res.body.system_prompt, /Mara Quinn/);
  assert.equal(res.body.meta.memory_folder, 'profiles');
  assert.ok(Array.isArray(res.body.memories));
  assert.equal(res.body.memories[0].title, 'Dad stopped calling');
  assert.match(res.body.system_prompt, /Things you remember from your life/);
  assert.equal(res.body.meta.memory_count, 1);
  const analyst = mistralRequests[0].messages.find(m => m.role === 'system').content;
  assert.match(analyst, /You are Psychologist/);
  assert.match(analyst, /Big Five/);
  assert.match(analyst, /People are not their DSM codes/);
  assert.ok(mistralRequests[0].max_tokens > 250);

  const saved = await request('GET', '/personality_profile?user_id=u1&person_name=Mara%20Quinn');
  assert.equal(saved.status, 200);
  assert.equal(saved.body.person_name, 'Mara Quinn');
  assert.match(saved.body.system_prompt, /Mara Quinn/);
  assert.equal(saved.body.memories[0].title, 'Dad stopped calling');

  const listed = await request('GET', '/personality_profiles?user_id=u1');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.profiles.length, 1);
  assert.equal(listed.body.profiles[0].person_key, 'mara_quinn');
  assert.equal(listed.body.profiles[0].memory_count, 1);
});

test('POST /wrestling_chat with person_name references saved document memories', async () => {
  mistralRequests.length = 0;
  const res = await request('POST', '/wrestling_chat', {
    user_id: 'u1',
    person_name: 'Mara Quinn',
    message: 'What happened with your dad?'
  });
  assert.equal(res.status, 200);
  const sent = mistralRequests[mistralRequests.length - 1];
  const contents = (sent.messages || []).map(m => m.content).join('\n');
  assert.match(contents, /Dad stopped calling/);
  assert.match(contents, /Things you remember from your life/);
});

test('POST /personality_profile accepts an uploaded text file', async () => {
  const res = await requestMultipart(
    '/personality_profile',
    { user_id: 'u2', person_name: 'Mara Quinn' },
    [{ field: 'file', filename: 'journal.txt', type: 'text/plain', body: 'I cannot sleep again.' }]
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.person_name, 'Mara Quinn');
  assert.equal(res.body.sources[0].filename, 'journal.txt');
});

test('GET /personality_profile 404s when nobody is stored', async () => {
  const res = await request('GET', '/personality_profile?user_id=u1&person_name=Nobody');
  assert.equal(res.status, 404);
});

test('POST /personality_profile rejects consent: false and notes privacy otherwise', async () => {
  const denied = await request('POST', '/personality_profile', {
    user_id: 'u-consent',
    person_name: 'Mara Quinn',
    document: 'I cannot sleep.',
    consent: false
  });
  assert.equal(denied.status, 400);
  assert.match(denied.body.error, /Consent/);

  const ok = await request('POST', '/personality_profile', {
    user_id: 'u-consent',
    person_name: 'Mara Quinn',
    document: 'I cannot sleep. I already said no.'
  });
  assert.equal(ok.status, 200);
  assert.match(ok.body.privacy_notice, /permission/i);
});

test('POST /wrestling_chat with person_name does not humanize by default and raises the token cap', async () => {
  mistralRequests.length = 0;
  const res = await request('POST', '/wrestling_chat', {
    user_id: 'u1',
    person_name: 'Mara Quinn',
    message: 'What happened with your dad?',
    system_p: 'Keep answers under two sentences.'
  });
  assert.equal(res.status, 200);
  const sent = mistralRequests[mistralRequests.length - 1];
  assert.equal(sent.max_tokens, 800);
  const contents = (sent.messages || []).map(m => m.content).join('\n');
  assert.match(contents, /Mara Quinn/);
  assert.match(contents, /Keep answers under two sentences/);
  assert.match(contents, /Stay consistent with this psychology/);
});

test('PATCH and DELETE personality_profile and a single memory', async () => {
  const created = await request('POST', '/personality_profile', {
    user_id: 'u-edit',
    person_name: 'Mara Quinn',
    document: 'I write after midnight. I already said no.'
  });
  assert.equal(created.status, 200);
  const memoryId = created.body.memories[0].id;
  assert.ok(memoryId);

  const patched = await request('PATCH', '/personality_profile', {
    user_id: 'u-edit',
    person_name: 'Mara Quinn',
    profile: { summary: 'Rewritten summary.' }
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.profile.summary, 'Rewritten summary.');

  const mem = await request('PATCH', '/personality_profile/memory', {
    user_id: 'u-edit',
    person_name: 'Mara Quinn',
    memory_id: memoryId,
    patch: { importance: 'low' }
  });
  assert.equal(mem.status, 200);
  assert.equal(mem.body.memory.importance, 'low');

  const removedMem = await request('DELETE', `/personality_profile/memory?user_id=u-edit&person_name=Mara%20Quinn&memory_id=${memoryId}`);
  assert.equal(removedMem.status, 200);
  assert.equal(removedMem.body.memories.some(m => m.id === memoryId), false);

  const gone = await request('DELETE', '/personality_profile?user_id=u-edit&person_name=Mara%20Quinn');
  assert.equal(gone.status, 200);
  const missing = await request('GET', '/personality_profile?user_id=u-edit&person_name=Mara%20Quinn');
  assert.equal(missing.status, 404);
});
