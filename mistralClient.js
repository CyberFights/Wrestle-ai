'use strict';

/*
 * mistralClient.js — thin wrapper around the Mistral chat-completions API.
 *
 * Adds three things the app needs on top of a raw axios POST:
 *
 *   1. A request timeout — a hung upstream request must not hang a user's
 *      turn forever (axios defaults to `timeout: 0`, i.e. never).
 *   2. Retries with exponential backoff + jitter for transient failures.
 *      Mistral answers with 429 / 5xx (e.g. 503 when the platform is
 *      overloaded), and those almost always succeed when retried shortly.
 *   3. Error descriptions that NEVER include the request config. Axios error
 *      objects carry `config.headers.Authorization` — the raw API key — so
 *      logging the raw error object leaks the key into the logs. Only
 *      describeMistralError() output should end up in logs or responses.
 */

const axios = require('axios');

const DEFAULT_URL = 'https://api.mistral.ai/v1/chat/completions';
const DEFAULT_MODEL = 'mistral-large-latest';

// Statuses worth retrying: rate limiting and transient server-side errors.
// 4xx client errors (400, 401, 403, 404…) fail every time, so they are not retried.
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function toPositiveInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function toNonNegativeInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Errors without a response (timeout, connection reset, DNS) are transient;
// errors with a response are retried only for the statuses above.
function isRetryableMistralError(error) {
  if (!error || !error.isAxiosError) return false;
  if (!error.response) return true;
  return RETRYABLE_STATUSES.has(error.response.status);
}

// Human-readable summary of a failed call. Deliberately built field by field
// so the Authorization header (or any other request header) can never leak
// into logs or HTTP responses.
function describeMistralError(error) {
  if (!error || !error.isAxiosError) {
    return `unexpected error: ${error && error.message ? error.message : String(error)}`;
  }
  if (!error.response) {
    return `no response from Mistral (${error.code || 'network/timeout'}): ${error.message}`;
  }
  const status = error.response.status;
  let body;
  try {
    body = typeof error.response.data === 'string'
      ? error.response.data
      : JSON.stringify(error.response.data);
  } catch (err) {
    body = String(error.response.data);
  }
  return `Mistral HTTP ${status}: ${String(body).slice(0, 500)}`;
}

function createMistralClient(options = {}) {
  const apiKey = options.apiKey ?? process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error('createMistralClient: an apiKey (or MISTRAL_API_KEY env var) is required');

  const url = options.url || process.env.MISTRAL_API_URL || DEFAULT_URL;
  const model = options.model || process.env.MISTRAL_MODEL || DEFAULT_MODEL;
  const timeoutMs = toPositiveInt(options.timeoutMs ?? process.env.MISTRAL_TIMEOUT_MS, 30000);
  const maxRetries = toNonNegativeInt(options.maxRetries ?? process.env.MISTRAL_MAX_RETRIES, 3);
  const baseDelayMs = toPositiveInt(options.baseDelayMs, 800);
  const maxDelayMs = toPositiveInt(options.maxDelayMs, 10000);
  const logger = options.logger || console;

  // Returns the assistant's reply text. Throws the original (sanitized-with
  // describeMistralError before logging!) error after all retries are spent.
  async function chat(messages, overrides = {}) {
    const body = {
      model,
      messages,
      max_tokens: overrides.max_tokens ?? 250,
      temperature: overrides.temperature ?? 0.8
    };

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await axios.post(url, body, {
          timeout: timeoutMs,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          }
        });

        const content = response?.data?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) {
          // Not an axios error — do not retry malformed 200 payloads forever.
          throw new Error('Mistral API returned an empty or malformed reply');
        }
        return content.trim();
      } catch (error) {
        const retryable = isRetryableMistralError(error);
        if (!retryable || attempt === maxRetries) throw error;

        // Exponential backoff with jitter: ~0.8s, ~1.6s, ~3.2s… capped at maxDelayMs.
        const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
        const delay = backoff + Math.floor(Math.random() * Math.max(1, baseDelayMs / 4));
        logger.warn(
          `Mistral API attempt ${attempt + 1} of ${maxRetries + 1} failed ` +
          `(${describeMistralError(error)}); retrying in ${delay}ms`
        );
        await sleep(delay);
      }
    }

    // Unreachable — the loop either returns or throws — but keeps linters happy.
    throw new Error('Mistral API call failed');
  }

  return { chat, url, model, timeoutMs, maxRetries };
}

module.exports = {
  createMistralClient,
  describeMistralError,
  isRetryableMistralError,
  RETRYABLE_STATUSES,
  DEFAULT_URL,
  DEFAULT_MODEL
};
