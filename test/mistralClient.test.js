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
  isRetryableMistralError
} = require('../mistralClient');

const API_KEY = 'test-secret-key-12345';

// Starts a stub "Mistral API". `script` is a list of HTTP status codes to
// answer, in order; the 200 answer returns a chat-completion-shaped body.
// Returns { url, requests, close } where `requests` logs every hit.
function startStub(script) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      requests.push({ authorization: req.headers.authorization, body: JSON.parse(raw || '{}') });
      const status = script[Math.min(requests.length - 1, script.length - 1)];
      if (status === 0) return; // hang forever — used for the timeout test
      res.writeHead(status, { 'Content-Type': 'application/json' });
      if (status === 200) {
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: ' your turn. ' } }] }));
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

test('classifies retryable errors correctly', () => {
  assert.equal(isRetryableMistralError({ isAxiosError: true, response: { status: 503 } }), true);
  assert.equal(isRetryableMistralError({ isAxiosError: true, response: { status: 429 } }), true);
  assert.equal(isRetryableMistralError({ isAxiosError: true, response: { status: 400 } }), false);
  assert.equal(isRetryableMistralError({ isAxiosError: true, response: { status: 401 } }), false);
  assert.equal(isRetryableMistralError({ isAxiosError: true, code: 'ECONNABORTED' }), true, 'timeouts retry');
  assert.equal(isRetryableMistralError(new TypeError('bug in our code')), false, 'local bugs must not retry');
});
