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
 *      overloaded) — and intermittently with empty or chunked-shaped
 *      completions — which almost always succeed when retried shortly.
 *   3. Error descriptions that NEVER include the request config. Axios error
 *      objects carry `config.headers.Authorization` — the raw API key — so
 *      logging the raw error object leaks the key into the logs. Only
 *      describeMistralError() output should end up in logs or responses.
 */

const axios = require('axios');

const DEFAULT_URL = 'https://api.mistral.ai/v1/chat/completions';
const DEFAULT_MODEL = 'mistral-large-latest';
const DEFAULT_MAX_TOKENS = 250;
// Empty replies cut short by the token limit are retried with a larger budget,
// capped here (an explicit larger max_tokens override is never shrunk).
const REPLY_LENGTH_MAX_TOKENS = 4096;

// Statuses worth retrying: rate limiting and transient server-side errors.
// 499 is a non-standard gateway status (nginx-style "client/upstream closed
// the connection", e.g. the upstream cut a slow request) — treat it like a
// transient 5xx rather than failing immediately.
// 4xx client errors (400, 401, 403, 404…) fail every time, so they are not retried.
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 499, 500, 502, 503, 504]);

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
// A received-but-unusable completion (empty content) is also treated as
// transient — Mistral answers with empty strings/nulls intermittently even
// for healthy requests — unless it was refused by the content filter, which
// is deterministic for an identical request.
function isRetryableMistralError(error) {
  if (error && error.isMistralReplyError) {
    return !(error.details && error.details.finishReason === 'content_filter');
  }
  if (!error || !error.isAxiosError) return false;
  if (!error.response) return true;
  return RETRYABLE_STATUSES.has(error.response.status);
}

// Extracts the assistant's reply text from a chat-completion payload.
// Mistral does not always return the documented shape:
//
//   1. Plain string content — the documented shape:
//        { choices: [{ message: { content: "..." } }] }
//   2. Content as an array of chunks (newer/larger models, multi-part or
//      reasoning outputs):
//        { choices: [{ message: { content: [{ type: 'text', text: '...' }] } }] }
//   3. The whole response delivered as a JSON string (double-encoded body,
//      e.g. when a proxy or the upstream mangles the Content-Type and axios
//      cannot auto-parse it):
//        "{\"choices\":[{\"message\":{\"content\":\"...\"}}]}"
//
// Returns { text, finishReason, shape } where `text` is '' when the reply
// carries no usable text and `shape` names what was found (used in logs so a
// persistent failure can be diagnosed without dumping the payload).
function extractMessageText(data) {
  let payload = data;
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed) return { text: '', finishReason: undefined, shape: 'data-string-empty' };
    try {
      payload = JSON.parse(trimmed);
    } catch (err) {
      return { text: '', finishReason: undefined, shape: 'data-string-unparseable' };
    }
  }

  const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : undefined;
  const message = choice && choice.message;
  const content = message ? message.content : undefined;
  const finishReason = choice && choice.finish_reason ? String(choice.finish_reason) : undefined;

  if (typeof content === 'string') {
    return { text: content.trim(), finishReason, shape: 'content-string' };
  }
  if (Array.isArray(content)) {
    let sawThinking = false;
    const text = content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part && (part.type === 'thinking' || Array.isArray(part.thinking))) {
          sawThinking = true;
          return '';
        }
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('')
      .trim();
    // Reasoning models can spend the whole token budget on thinking chunks
    // and leave nothing for a text chunk — worth flagging in logs.
    return { text, finishReason, shape: 'content-chunks', thinkingOnly: sawThinking && text === '' };
  }
  if (content == null) {
    return { text: '', finishReason, shape: payload == null ? 'no-payload' : 'content-missing' };
  }
  return { text: '', finishReason, shape: `content-${typeof content}` };
}

// Marks a received-but-unusable completion so the retry logic can treat it
// as transient and describeMistralError() can report why it was rejected.
function makeReplyError(message, details = {}) {
  const error = new Error(message);
  error.isMistralReplyError = true;
  error.details = details;
  return error;
}

// Human-readable summary of a failed call. Deliberately built field by field
// so the Authorization header (or any other request header) can never leak
// into logs or HTTP responses.
function describeMistralError(error) {
  if (error && error.isMistralReplyError) {
    const details = error.details || {};
    const bits = [`shape=${details.shape || 'unknown'}`];
    if (details.finishReason) bits.push(`finish_reason=${details.finishReason}`);
    if (details.thinkingOnly) bits.push('reasoning_only=true');
    return `unexpected error: ${error.message} (${bits.join(', ')})`;
  }
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

// Normalizes a reasoning_effort override. Mistral reasoning models accept
// "none" / "high" (some accept "low" / "max"); every other model rejects the
// parameter outright with HTTP 400, so it is only ever sent when configured.
function toReasoningEffort(value) {
  const effort = value == null ? '' : String(value).trim().toLowerCase();
  return effort || undefined;
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
  // Set MISTRAL_REASONING_EFFORT=none to make reasoning models (magistral-*,
  // mistral-medium-3-5, mistral-small-2603) skip the thinking phase — without
  // it they can burn the whole token budget (and seconds of wall-clock time)
  // on reasoning before answering. Leave unset for models that reject the
  // parameter (mistral-large-latest, codestral, ministral-*): they 400 on it.
  const reasoningEffort = toReasoningEffort(options.reasoningEffort ?? process.env.MISTRAL_REASONING_EFFORT);
  const logger = options.logger || console;

  // Returns the assistant's reply text. Throws the original (sanitized-with
  // describeMistralError before logging!) error after all retries are spent.
  async function chat(messages, overrides = {}) {
    const requestedMaxTokens = overrides.max_tokens ?? DEFAULT_MAX_TOKENS;
    // Reasoning models can burn the whole default token budget on thinking
    // chunks; when a reply is cut short by the limit we grow the budget on
    // retries instead of re-sending the same token-starved request.
    const lengthCap = Math.max(REPLY_LENGTH_MAX_TOKENS, requestedMaxTokens);
    let effectiveMaxTokens = requestedMaxTokens;
    const temperature = overrides.temperature ?? 0.8;
    const requestTimeoutMs = toPositiveInt(overrides.timeoutMs, timeoutMs);
    const effectiveReasoningEffort = toReasoningEffort(overrides.reasoningEffort) ?? reasoningEffort;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const body = {
        model,
        messages,
        max_tokens: effectiveMaxTokens,
        temperature
      };
      if (effectiveReasoningEffort) body.reasoning_effort = effectiveReasoningEffort;
      try {
        const response = await axios.post(url, body, {
          timeout: requestTimeoutMs,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          }
        });

        const { text, finishReason, shape, thinkingOnly } = extractMessageText(response ? response.data : undefined);
        if (!text) {
          // Empty/malformed completions happen intermittently on Mistral's
          // side, so they are retried like transient HTTP failures (unless
          // the content filter refused the request). The details are kept
          // on the error so logs can show *why* the reply was rejected.
          throw makeReplyError('Mistral API returned an empty or malformed reply', { finishReason, shape, thinkingOnly });
        }
        return text;
      } catch (error) {
        const retryable = isRetryableMistralError(error);
        if (!retryable || attempt === maxRetries) throw error;

        // If the model hit the token limit before emitting any text (typical
        // for reasoning models), grow max_tokens for the next attempt;
        // re-sending the same budget would fail the same way.
        if (error.isMistralReplyError && error.details && error.details.finishReason === 'length') {
          effectiveMaxTokens = Math.min(lengthCap, Math.max(effectiveMaxTokens * 4, 1024));
        }

        // Exponential backoff with jitter: ~0.8s, ~1.6s, ~3.2s… capped at maxDelayMs.
        const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
        const delay = backoff + Math.floor(Math.random() * Math.max(1, baseDelayMs / 4));
        const thinkingHint = error.isMistralReplyError && error.details && error.details.thinkingOnly && !effectiveReasoningEffort
          ? ' Hint: the model spent the budget on thinking — set MISTRAL_REASONING_EFFORT=none to disable reasoning on reasoning models.'
          : '';
        logger.warn(
          `Mistral API attempt ${attempt + 1} of ${maxRetries + 1} failed ` +
          `(${describeMistralError(error)}); retrying in ${delay}ms${thinkingHint}`
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
  extractMessageText,
  RETRYABLE_STATUSES,
  DEFAULT_URL,
  DEFAULT_MODEL
};
