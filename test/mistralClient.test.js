'use strict';

/*
 * Tests for mistralClient.js — run with: npm test
 *
 * Spins up a local HTTP server that plays the role of the Mistral API and
 * answers with scripted statuses, so retry / timeout / error-sanitizing
 * behavior can be checked without touching the real API.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  createMistralClient,
  describeMistralError,
  isRetryableMistralError,
  extractMessageText
} = require('../mistralClient');

const API_KEY = 'test-secret-key-12345';

// Starts a stub "Mistral API". `script` is a list of answers, in order; each
// entry is either a status code or { status, body } for a custom 200 payload
// (body is sent as JSON; pass `bodyRaw` to send a pre-serialized string).
// A plain 200 answers with a chat-completion-shaped body.
// Returns { url, requests, close } where `requests` logs every hit.
function startStub(script) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      requests.push({ authorization: req.headers.authorization, body: JSON.parse(raw || '{}') });
      const entry = script[Math.min(requests.length - 1, script.length - 1)];
      const status = typeof entry === 'number' ? entry : entry.status;
      if (status === 0) return; // hang forever — used for the timeout test
      res.writeHead(status, { 'Content-Type': 'application/json' });
      if (status === 200) {
        if (entry && entry.bodyRaw !== undefined) {
          res.end(entry.bodyRaw);
        } else {
          res.end(JSON.stringify(entry && entry.body !== undefined
            ? entry.body
            : { choices: [{ message: { role: 'assistant', content: ' your turn. ' } }] }));
        }
      } else {
        res.end(JSON.stringify({ message: `stub error ${status}` }));
      }
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
        requests,
        close: () => new Promise(done => server.close(done))
      });
    });
  });
}

function makeClient(url, extra = {}) {
  // Tiny delays keep the retries fast; silence the retry warnings.
  return createMistralClient({
    apiKey: API_KEY,
    url,
    baseDelayMs: 1,
    maxDelayMs: 5,
    logger: { warn() {} },
    ...extra
  });
}

test('retries through transient 503s and then succeeds', async t => {
  const stub = await startStub([503, 503, 200]);
  t.after(() => stub.close());

  const reply = await makeClient(stub.url).chat([{ role: 'user', content: 'I punch you' }]);

  assert.equal(reply, 'your turn.');
  assert.equal(stub.requests.length, 3, 'expected 2 retries after the first attempt');
  assert.equal(stub.requests[0].authorization, `Bearer ${API_KEY}`);
  assert.equal(stub.requests[0].body.max_tokens, 250);
  assert.equal(stub.requests[0].body.messages[0].content, 'I punch you');
});

test('gives up after all retries on a persistent 503', async t => {
  const stub = await startStub([503, 503, 503, 503, 503]);
  t.after(() => stub.close());

  await assert.rejects(
    () => makeClient(stub.url, { maxRetries: 2 }).chat([{ role: 'user', content: 'hi' }]),
    error => error.response && error.response.status === 503
  );
  assert.equal(stub.requests.length, 3, 'expected 1 initial attempt + 2 retries, no more');
});

test('does NOT retry a permanent 4xx client error', async t => {
  const stub = await startStub([400, 400, 200]);
  t.after(() => stub.close());

  await assert.rejects(
    () => makeClient(stub.url).chat([{ role: 'user', content: 'hi' }]),
    error => error.response && error.response.status === 400
  );
  assert.equal(stub.requests.length, 1, 'a 400 must not be retried');
});

test('times out a hung request instead of waiting forever', async t => {
  const stub = await startStub([0]); // 0 = never respond
  t.after(() => stub.close());

  await assert.rejects(
    () => makeClient(stub.url, { timeoutMs: 200, maxRetries: 0 }).chat([{ role: 'user', content: 'hi' }]),
    /timeout/i
  );
});

test('chat can raise the timeout for a single long call', async t => {
  const stub = await startStub([0]);
  t.after(() => stub.close());
  const client = makeClient(stub.url, { timeoutMs: 5000, maxRetries: 0 });
  const started = Date.now();
  await assert.rejects(
    () => client.chat([{ role: 'user', content: 'hi' }], { timeoutMs: 150 }),
    /timeout/i
  );
  assert.ok(Date.now() - started < 1500, 'per-call timeoutMs must win over the client default');
});

test('error description never leaks the API key', async t => {
  const stub = await startStub([503]);
  t.after(() => stub.close());

  let failure;
  try {
    await makeClient(stub.url, { maxRetries: 0 }).chat([{ role: 'user', content: 'hi' }]);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, 'call should have failed');

  const description = describeMistralError(failure);
  assert.match(description, /503/);
  assert.ok(!description.includes(API_KEY), 'description must not contain the API key');
  // And the raw config string — what console.error(error) would print — is the
  // thing we must never log; make sure describe output differs from it.
  assert.ok(description.length < 1000, 'description stays a short summary, not a config dump');
});

test('accepts content delivered as an array of chunks', async t => {
  const stub = await startStub([
    {
      status: 200,
      body: {
        choices: [{
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: [{ type: 'text', text: 'internal reasoning' }] },
              { type: 'text', text: 'Your ' },
              { type: 'text', text: 'turn.' }
            ]
          },
          finish_reason: 'stop'
        }]
      }
    }
  ]);
  t.after(() => stub.close());

  const reply = await makeClient(stub.url, { maxRetries: 0 }).chat([{ role: 'user', content: 'hi' }]);
  assert.equal(reply, 'Your turn.');
});

test('accepts a double-encoded JSON response body', async t => {
  const inner = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'wrapped reply' } }] });
  const stub = await startStub([{ status: 200, bodyRaw: JSON.stringify(inner) }]);
  t.after(() => stub.close());

  const reply = await makeClient(stub.url, { maxRetries: 0 }).chat([{ role: 'user', content: 'hi' }]);
  assert.equal(reply, 'wrapped reply');
});

test('treats an unparseable string body as empty and retries it', async t => {
  const stub = await startStub([
    { status: 200, bodyRaw: '<html>upstream proxy error</html>' },
    { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'recovered' } }] } }
  ]);
  t.after(() => stub.close());

  const reply = await makeClient(stub.url).chat([{ role: 'user', content: 'hi' }]);
  assert.equal(reply, 'recovered');
  assert.equal(stub.requests.length, 2, 'a transient garbage 200 body must be retried');
});

test('retries a transient empty reply and then succeeds', async t => {
  const stub = await startStub([
    { status: 200, body: { choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] } },
    { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'second try' } }] } }
  ]);
  t.after(() => stub.close());

  const reply = await makeClient(stub.url).chat([{ role: 'user', content: 'hi' }]);
  assert.equal(reply, 'second try');
  assert.equal(stub.requests.length, 2);
});

test('gives up after all retries on a persistent empty reply and reports why', async t => {
  const stub = await startStub([
    { status: 200, body: { choices: [{ message: { role: 'assistant', content: null }, finish_reason: 'length' }] } }
  ]);
  t.after(() => stub.close());

  let failure;
  try {
    await makeClient(stub.url, { maxRetries: 2 }).chat([{ role: 'user', content: 'hi' }]);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, 'the call should have failed');
  assert.equal(stub.requests.length, 3, 'initial attempt + 2 retries');
  assert.equal(failure.isMistralReplyError, true);
  assert.match(failure.message, /empty or malformed reply/);

  const description = describeMistralError(failure);
  assert.match(description, /Mistral API returned an empty or malformed reply/);
  assert.match(description, /shape=content-missing/, 'description should say the content was missing');
  assert.match(description, /finish_reason=length/, 'description should carry the upstream finish_reason');
  assert.ok(!description.includes(API_KEY), 'description must not contain the API key');
});

test('does not retry a content-filter refusal', async t => {
  const stub = await startStub([
    { status: 200, body: { choices: [{ message: { role: 'assistant' }, finish_reason: 'content_filter' }] } }
  ]);
  t.after(() => stub.close());

  await assert.rejects(
    () => makeClient(stub.url).chat([{ role: 'user', content: 'hi' }]),
    error => error.isMistralReplyError === true
  );
  assert.equal(stub.requests.length, 1, 'a content filter refusal is deterministic and must not be retried');
});

test('escalates max_tokens when a reply is cut short by the token limit', async t => {
  const thinkingOnlyBody = {
    choices: [{
      message: { content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'reasoning exhausts the budget' }] }] },
      finish_reason: 'length'
    }]
  };
  const stub = await startStub([
    { status: 200, body: thinkingOnlyBody },
    { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'full reply' }, finish_reason: 'stop' }] } }
  ]);
  t.after(() => stub.close());

  const reply = await makeClient(stub.url).chat([{ role: 'user', content: 'hi' }]);
  assert.equal(reply, 'full reply');
  assert.equal(stub.requests.length, 2);
  assert.equal(stub.requests[0].body.max_tokens, 250, 'first attempt uses the default budget');
  assert.ok(
    stub.requests[1].body.max_tokens >= 1024,
    `retry must grow the token budget, got ${stub.requests[1].body.max_tokens}`
  );
});

test('reports reasoning_only=true when only thinking chunks were produced', async t => {
  const stub = await startStub([
    {
      status: 200,
      body: {
        choices: [{
          message: { content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'still thinking' }] }] },
          finish_reason: 'length'
        }]
      }
    }
  ]);
  t.after(() => stub.close());

  let failure;
  try {
    await makeClient(stub.url, { maxRetries: 0 }).chat([{ role: 'user', content: 'hi' }]);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, 'the call should have failed');
  const description = describeMistralError(failure);
  assert.match(description, /shape=content-chunks/);
  assert.match(description, /finish_reason=length/);
  assert.match(description, /reasoning_only=true/);
});

test('does not shrink an explicit max_tokens above the escalation cap', async t => {
  const stub = await startStub([
    { status: 200, body: { choices: [{ message: { role: 'assistant', content: null }, finish_reason: 'length' }] } },
    { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] } }
  ]);
  t.after(() => stub.close());

  const reply = await makeClient(stub.url).chat(
    [{ role: 'user', content: 'hi' }],
    { max_tokens: 5000 }
  );
  assert.equal(reply, 'ok');
  assert.equal(stub.requests[0].body.max_tokens, 5000);
  assert.equal(stub.requests[1].body.max_tokens, 5000, 'explicit override above the cap must not be shrunk');
});

test('extractMessageText normalizes the shapes Mistral returns', () => {
  assert.deepEqual(
    extractMessageText({ choices: [{ message: { content: ' hello ' } }] }).text,
    'hello'
  );
  assert.deepEqual(
    extractMessageText({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] }).text,
    'ab'
  );
  assert.equal(extractMessageText('not json at all').shape, 'data-string-unparseable');
  assert.equal(extractMessageText(undefined).shape, 'no-payload');
  assert.equal(extractMessageText({ choices: [] }).shape, 'content-missing');
  assert.equal(extractMessageText({ choices: [{ message: { content: 42 } }] }).shape, 'content-number');
  const thinkingOnly = extractMessageText({
    choices: [{ message: { content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'hmm' }] }] }, finish_reason: 'length' }]
  });
  assert.equal(thinkingOnly.text, '');
  assert.equal(thinkingOnly.thinkingOnly, true);
  assert.equal(thinkingOnly.finishReason, 'length');
});

test('classifies retryable errors correctly', () => {
  assert.equal(isRetryableMistralError({ isAxiosError: true, response: { status: 503 } }), true);
  assert.equal(isRetryableMistralError({ isAxiosError: true, response: { status: 429 } }), true);
  assert.equal(isRetryableMistralError({ isAxiosError: true, response: { status: 400 } }), false);
  assert.equal(isRetryableMistralError({ isAxiosError: true, response: { status: 401 } }), false);
  assert.equal(isRetryableMistralError({ isAxiosError: true, code: 'ECONNABORTED' }), true, 'timeouts retry');
  assert.equal(isRetryableMistralError({ isMistralReplyError: true, details: { finishReason: 'length' } }), true, 'empty replies retry');
  assert.equal(isRetryableMistralError({ isMistralReplyError: true, details: { finishReason: 'content_filter' } }), false, 'content filter refusals do not retry');
  assert.equal(isRetryableMistralError(new TypeError('bug in our code')), false, 'local bugs must not retry');
});
