'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { humanizeText, humanizeResponse } = require('../humanizer');

test('humanizer turns common formal phrasing into natural conversational wording', () => {
  const input = 'It is important to note that I am not backing down. I will keep fighting because I cannot quit.';

  assert.equal(
    humanizeText(input),
    "I'm not backing down. I'll keep fighting because I can't quit."
  );
});

test('humanizer keeps the original actions and sentence order intact', () => {
  const input = 'At this point in time, I am going to grab the ropes. Additionally, you are not getting past me.';

  assert.equal(
    humanizeText(input),
    "Now, I'm going to grab the ropes. Also, you're not getting past me."
  );
});

test('humanizer does not rewrite URLs or inline/fenced code', () => {
  const input = 'I am ready. Read `I am not changing` and visit https://example.test/I_am.\n```txt\nI will not change\n```';

  assert.equal(
    humanizeText(input),
    "I'm ready. Read `I am not changing` and visit https://example.test/I_am.\n```txt\nI will not change\n```"
  );
});

test('humanizer can be disabled without changing the response', () => {
  const input = 'I am ready, and I will not quit.';

  assert.equal(humanizeResponse(input, { enabled: false }), input);
});
