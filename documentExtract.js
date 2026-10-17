'use strict';

/*
 * documentExtract.js — turn an uploaded buffer into plain text the profiler
 * can read. Text-like formats are handled locally; PDF and DOCX use optional
 * dependencies (pdf-parse / mammoth) when they are installed.
 *
 * Binary types that are not documents (images, audio, video, archives other
 * than docx) are rejected rather than being sent to the model as garbage.
 */

const path = require('path');

const TEXT_EXTENSIONS = new Set([
  '.txt', '.text', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl',
  '.html', '.htm', '.xml', '.log', '.rtf', '.yml', '.yaml', '.ini', '.cfg',
  '.eml', '.mbox', '.tex', '.rst', '.org'
]);

const TEXT_MIME_PREFIXES = [
  'text/',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/rtf',
  'application/xhtml+xml'
];

class DocumentExtractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DocumentExtractError';
    this.code = code;
  }
}

function extensionOf(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return ext;
}

function sniffMagic(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)) {
    return 'zip';
  }
  if (buffer.slice(0, 5).toString('latin1') === '{\\rtf') return 'rtf';
  return null;
}

function looksLikeText(buffer) {
  if (!buffer || !buffer.length) return false;
  const sample = buffer.slice(0, Math.min(buffer.length, 4096));
  let odd = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const b = sample[i];
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) odd += 1;
  }
  return odd / sample.length < 0.1;
}

function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.slice(2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.alloc(buffer.length - 2);
    for (let i = 2; i + 1 < buffer.length; i += 2) {
      swapped[i - 2] = buffer[i + 1];
      swapped[i - 1] = buffer[i];
    }
    return swapped.toString('utf16le');
  }
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function stripRtf(rtf) {
  return String(rtf)
    .replace(/\\'[0-9a-fA-F]{2}/g, ' ')
    .replace(/\\[a-zA-Z]+-?\d* ?/g, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function prettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch (err) {
    return text;
  }
}

function isTextMime(mimetype) {
  const mime = String(mimetype || '').toLowerCase();
  return TEXT_MIME_PREFIXES.some(prefix => mime.startsWith(prefix));
}

function isUnsupportedBinary(filename, mimetype, magic) {
  const ext = extensionOf(filename);
  const mime = String(mimetype || '').toLowerCase();
  const binaryExts = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.ico',
    '.mp3', '.wav', '.ogg', '.flac', '.m4a', '.mp4', '.mov', '.avi', '.webm',
    '.zip', '.rar', '.7z', '.gz', '.tar', '.exe', '.dll', '.bin', '.wasm',
    '.woff', '.woff2', '.ttf', '.otf'
  ]);
  if (binaryExts.has(ext)) return true;
  if (mime.startsWith('image/') || mime.startsWith('audio/') || mime.startsWith('video/')) return true;
  if (magic === 'zip' && ext !== '.docx' && !mime.includes('wordprocessingml')) return true;
  return false;
}

async function extractPdf(buffer) {
  let pdfParse;
  try {
    pdfParse = require('pdf-parse');
  } catch (err) {
    throw new DocumentExtractError(
      'PDF_SUPPORT_MISSING',
      'PDF files need the pdf-parse package. Install it or upload a .txt/.md/.docx copy.'
    );
  }
  const result = await pdfParse(buffer);
  return String(result && result.text ? result.text : '').trim();
}

async function extractDocx(buffer) {
  let mammoth;
  try {
    mammoth = require('mammoth');
  } catch (err) {
    throw new DocumentExtractError(
      'DOCX_SUPPORT_MISSING',
      'DOCX files need the mammoth package. Install it or upload a .txt/.md copy.'
    );
  }
  const result = await mammoth.extractRawText({ buffer });
  return String(result && result.value ? result.value : '').trim();
}

async function extractDocument({ buffer, filename, mimetype } = {}) {
  if (!buffer || !buffer.length) {
    throw new DocumentExtractError('EMPTY_DOCUMENT', `No content in ${filename || 'upload'}.`);
  }

  const name = filename || 'upload';
  const ext = extensionOf(name);
  const mime = String(mimetype || '').toLowerCase();
  const magic = sniffMagic(buffer);

  if (isUnsupportedBinary(name, mime, magic)) {
    throw new DocumentExtractError(
      'UNSUPPORTED_TYPE',
      `Cannot extract text from ${name}. Upload a document (txt, md, json, html, csv, rtf, pdf, docx) or paste the text.`
    );
  }

  const wantsPdf = magic === 'pdf' || ext === '.pdf' || mime === 'application/pdf';
  const wantsDocx = ext === '.docx' || mime.includes('wordprocessingml') || mime.includes('officedocument.wordprocessingml');

  let text = '';
  if (wantsPdf) {
    text = await extractPdf(buffer);
  } else if (wantsDocx) {
    text = await extractDocx(buffer);
  } else if (ext === '.rtf' || mime === 'application/rtf' || magic === 'rtf') {
    text = stripRtf(decodeText(buffer));
  } else if (ext === '.html' || ext === '.htm' || mime.includes('html')) {
    text = stripHtml(decodeText(buffer));
  } else if (ext === '.json' || ext === '.jsonl' || mime.includes('json')) {
    text = prettyJson(decodeText(buffer));
  } else if (TEXT_EXTENSIONS.has(ext) || isTextMime(mime) || looksLikeText(buffer)) {
    text = decodeText(buffer);
  } else {
    throw new DocumentExtractError(
      'UNSUPPORTED_TYPE',
      `Cannot extract text from ${name}. Upload a document (txt, md, json, html, csv, rtf, pdf, docx) or paste the text.`
    );
  }

  text = String(text || '').replace(/\u0000/g, '').trim();
  if (!text) {
    throw new DocumentExtractError('EMPTY_DOCUMENT', `No readable text in ${name}.`);
  }
  return { filename: name, text, charCount: text.length };
}

async function extractDocuments(files = []) {
  const extracted = [];
  for (const file of files) {
    extracted.push(await extractDocument(file));
  }
  return extracted;
}

module.exports = {
  DocumentExtractError,
  extractDocument,
  extractDocuments,
  stripHtml,
  stripRtf,
  looksLikeText
};
