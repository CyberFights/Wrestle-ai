'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractDocument,
  stripHtml,
  stripRtf,
  DocumentExtractError
} = require('../documentExtract');

test('extracts a plain text journal', async () => {
  const result = await extractDocument({
    buffer: Buffer.from('Day 1. I cannot sleep. The house ticks like a clock.'),
    filename: 'journal.txt',
    mimetype: 'text/plain'
  });
  assert.match(result.text, /cannot sleep/);
  assert.equal(result.filename, 'journal.txt');
  assert.ok(result.charCount > 10);
});

test('strips HTML to readable text', async () => {
  const result = await extractDocument({
    buffer: Buffer.from('<html><body><p>She <b>hates</b> small talk.</p></body></html>'),
    filename: 'notes.html',
    mimetype: 'text/html'
  });
  assert.equal(result.text, 'She hates small talk.');
  assert.equal(stripHtml('<script>alert(1)</script>Hi'), 'Hi');
});

test('pretty-prints JSON documents', async () => {
  const result = await extractDocument({
    buffer: Buffer.from('{"mood":"defiant","note":"never again"}'),
    filename: 'entry.json',
    mimetype: 'application/json'
  });
  assert.match(result.text, /"mood": "defiant"/);
});

test('strips RTF control words', () => {
  assert.match(stripRtf('{\\rtf1\\ansi Hello \\b world}'), /Hello world/);
});

test('rejects empty uploads', async () => {
  await assert.rejects(
    () => extractDocument({ buffer: Buffer.alloc(0), filename: 'empty.txt' }),
    err => err instanceof DocumentExtractError && err.code === 'EMPTY_DOCUMENT'
  );
});

test('rejects images and other non-documents', async () => {
  await assert.rejects(
    () => extractDocument({
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
      filename: 'face.png',
      mimetype: 'image/png'
    }),
    err => err instanceof DocumentExtractError && err.code === 'UNSUPPORTED_TYPE'
  );
});
