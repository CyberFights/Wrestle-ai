'use strict';

/*
 * A small, deliberately conservative response humanizer.
 *
 * It runs entirely in this process: there is no third-party API, account,
 * token, or per-request charge. Rather than generating new content (which
 * could change a wrestling move or take control of the opponent), it only
 * makes common overly formal wording more conversational. URLs and inline or
 * fenced code are left untouched.
 */

const PROTECTED_SEGMENTS = /```[\s\S]*?```|`[^`\r\n]*`|(?:https?:\/\/|www\.)[^\s<>()]+/gi;

// Keep the replacement's capitalization natural when a match begins a
// sentence or is written in all caps.
function matchCase(source, replacement) {
  if (!source || !replacement) return replacement;
  if (source === source.toUpperCase()) return replacement.toUpperCase();
  if (source[0] === source[0].toUpperCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

// Longer / phrase-level substitutions run first. The list intentionally stays
// small so that the humanizer polishes wording without inventing, removing, or
// reordering roleplay actions.
const REWRITES = [
  { pattern: /\bIt is important to note that\s*/gi, replacement: '' },
  { pattern: /\bAt this point in time\b/gi, replacement: 'now' },
  { pattern: /\bIn order to\b/gi, replacement: 'to' },
  { pattern: /\bFor the purpose of\b/gi, replacement: 'to' },
  { pattern: /\bWith regard to\b/gi, replacement: 'about' },
  { pattern: /\bAdditionally,\s*/gi, replacement: 'Also, ' },
  { pattern: /\bFurthermore,\s*/gi, replacement: 'Plus, ' },

  // Specific negatives must precede their shorter positive forms.
  { pattern: /\bI am not\b/gi, replacement: "I'm not" },
  { pattern: /\bI will not\b/gi, replacement: "I won't" },
  { pattern: /\bI cannot\b/gi, replacement: "I can't" },
  { pattern: /\bI can not\b/gi, replacement: "I can't" },
  { pattern: /\bI have been\b/gi, replacement: "I've been" },
  { pattern: /\bI would\b/gi, replacement: "I'd" },
  { pattern: /\bI will\b/gi, replacement: "I'll" },
  { pattern: /\bI am\b/gi, replacement: "I'm" },

  { pattern: /\byou are\b/gi, replacement: "you're" },
  { pattern: /\bwe are\b/gi, replacement: "we're" },
  { pattern: /\bthey are\b/gi, replacement: "they're" },
  { pattern: /\bit is\b/gi, replacement: "it's" },
  { pattern: /\bthat is\b/gi, replacement: "that's" },
  { pattern: /\bthere is\b/gi, replacement: "there's" },
  { pattern: /\bwhat is\b/gi, replacement: "what's" },

  { pattern: /\bdo not\b/gi, replacement: "don't" },
  { pattern: /\bdoes not\b/gi, replacement: "doesn't" },
  { pattern: /\bdid not\b/gi, replacement: "didn't" },
  { pattern: /\bwill not\b/gi, replacement: "won't" },
  { pattern: /\bcannot\b/gi, replacement: "can't" },
  { pattern: /\bcan not\b/gi, replacement: "can't" },
  { pattern: /\bis not\b/gi, replacement: "isn't" },
  { pattern: /\bare not\b/gi, replacement: "aren't" },
  { pattern: /\bwas not\b/gi, replacement: "wasn't" },
  { pattern: /\bwere not\b/gi, replacement: "weren't" }
];

function humanizeSegment(text) {
  let result = text;
  for (const { pattern, replacement } of REWRITES) {
    result = result.replace(pattern, match => matchCase(match, replacement));
  }

  // Removing a boilerplate phrase can leave whitespace before punctuation.
  return result.replace(/[ \t]+([,.;!?])/g, '$1');
}

function humanizeText(value, options = {}) {
  const text = value == null ? '' : String(value);
  if (!text || options?.enabled === false) return text;

  let result = '';
  let cursor = 0;
  const matcher = new RegExp(PROTECTED_SEGMENTS.source, PROTECTED_SEGMENTS.flags);
  let protectedMatch;

  while ((protectedMatch = matcher.exec(text)) !== null) {
    result += humanizeSegment(text.slice(cursor, protectedMatch.index));
    result += protectedMatch[0];
    cursor = protectedMatch.index + protectedMatch[0].length;
  }

  result += humanizeSegment(text.slice(cursor));
  return result;
}

// Alias makes the pipeline's intent clear at its call site.
function humanizeResponse(value, options) {
  return humanizeText(value, options);
}

module.exports = {
  humanizeText,
  humanizeResponse
};
