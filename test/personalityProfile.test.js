'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseJsonFromModel,
  normalizeProfile,
  buildSystemPrompt,
  collectBodyDocuments,
  combineSources
} = require('../personalityProfile');

test('parseJsonFromModel accepts fenced JSON', () => {
  const parsed = parseJsonFromModel('```json\n{"person_name":"Ada","summary":"Inventor."}\n```');
  assert.equal(parsed.person_name, 'Ada');
});

test('parseJsonFromModel pulls the object out of extra prose', () => {
  const parsed = parseJsonFromModel('Here you go:\n{"person_name":"Nia","summary":"Quiet."}\nThanks');
  assert.equal(parsed.person_name, 'Nia');
});

test('normalizeProfile coerces strings and marks indicators as not diagnoses', () => {
  const profile = normalizeProfile({
    person_name: 'Sam',
    summary: 'A careful writer.',
    personality_traits: ['wry', { trait: 'loyal', evidence: 'stayed' }],
    psychological_disorders: [{ label: 'low mood', evidence: 'journal week 3' }],
    values: 'honesty',
    speech_patterns: { tone: 'dry', catchphrases: ['anyway'] }
  }, 'Fallback');

  assert.equal(profile.person_name, 'Sam');
  assert.equal(profile.personality_traits[0].trait, 'wry');
  assert.equal(profile.psychological_indicators[0].not_a_diagnosis, true);
  assert.match(profile.disclaimer, /Not a clinical/);
  assert.equal(profile.speech_patterns.tone, 'dry');
  assert.deepEqual(profile.values, ['honesty']);
});

test('buildSystemPrompt recreates the person in first person', () => {
  const prompt = buildSystemPrompt({
    person_name: 'Mara Quinn',
    summary: 'Sharp, private, loyal to a fault.',
    personality_traits: [{ trait: 'guarded', description: 'shares late' }],
    speech_patterns: {
      overview: 'Short sentences. Then a longer one when angry.',
      tone: 'dry',
      catchphrases: ['figure it out'],
      example_lines: ['I already said no.']
    },
    ideologies: [{ label: 'self-reliance', description: 'asks for nothing' }],
    values: ['loyalty'],
    fears: ['being a burden']
  });

  assert.match(prompt, /You are Mara Quinn/);
  assert.match(prompt, /first person/);
  assert.match(prompt, /guarded/);
  assert.match(prompt, /self-reliance/);
  assert.match(prompt, /I already said no/);
});

test('collectBodyDocuments reads document, text, and documents[]', () => {
  const docs = collectBodyDocuments({
    document: 'page one',
    filename: 'one.txt',
    documents: ['page two', { filename: 'three.md', text: 'page three' }]
  });
  assert.equal(docs.length, 3);
  assert.equal(docs[0].filename, 'one.txt');
  assert.equal(docs[2].filename, 'three.md');
});

test('combineSources caps total characters and records excerpts', () => {
  const { combined, sources, truncated } = combineSources(
    [{ filename: 'a.txt', text: 'aaaa' }, { filename: 'b.txt', text: 'bbbbbbbb' }],
    40
  );
  assert.match(combined, /FILE: a.txt/);
  assert.equal(sources[0].filename, 'a.txt');
  assert.ok(sources[0].excerpt.length <= 800);
  assert.equal(typeof truncated, 'boolean');
});
