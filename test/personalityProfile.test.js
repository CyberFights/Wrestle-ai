'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ANALYST_SYSTEM_PROMPT,
  parseJsonFromModel,
  normalizeProfile,
  normalizeMemories,
  mergeMemories,
  formatMemoriesForModel,
  buildSystemPrompt,
  collectBodyDocuments,
  combineSources,
  retrieveMemories,
  mergeSystemPrompts,
  detectPerspective,
  withMemoryIds,
  PROFILE_MISTRAL_TIMEOUT_MS
} = require('../personalityProfile');
const { chunkDocuments, mergeMemoriesWithConflicts, PRIVACY_NOTICE } = require('../personaMemory');

test('profile analysis waits longer than a chat turn for Mistral', () => {
  assert.ok(PROFILE_MISTRAL_TIMEOUT_MS >= 60000);
});

test('analyst prompt uses the academic psychologist method', () => {
  assert.match(ANALYST_SYSTEM_PROMPT, /You are Psychologist/);
  assert.match(ANALYST_SYSTEM_PROMPT, /Big Five/);
  assert.match(ANALYST_SYSTEM_PROMPT, /attachment/i);
  assert.match(ANALYST_SYSTEM_PROMPT, /Vaillant/);
  assert.match(ANALYST_SYSTEM_PROMPT, /Never reduce a person to a diagnosis/);
  assert.match(ANALYST_SYSTEM_PROMPT, /People are not their DSM codes/);
  assert.match(ANALYST_SYSTEM_PROMPT, /Observe before diagnosing/);
  assert.match(ANALYST_SYSTEM_PROMPT, /Extract \*\*memories\*\*/);
});

test('parseJsonFromModel accepts fenced JSON', () => {
  const parsed = parseJsonFromModel('```json\n{"person_name":"Ada","summary":"Inventor."}\n```');
  assert.equal(parsed.person_name, 'Ada');
});

test('parseJsonFromModel pulls the object out of extra prose', () => {
  const parsed = parseJsonFromModel('Here you go:\n{"person_name":"Nia","summary":"Quiet."}\nThanks');
  assert.equal(parsed.person_name, 'Nia');
});

test('parseJsonFromModel repairs JSON cut off mid-string', () => {
  const parsed = parseJsonFromModel('{"person_name":"Greg","summary":"A careful writer who');
  assert.equal(parsed.person_name, 'Greg');
  assert.match(parsed.summary, /careful writer/);
});

test('parseJsonFromModel repairs JSON cut off after a nested object', () => {
  const parsed = parseJsonFromModel('{"person_name":"Ada","attachment":{"style":"Secure","evidence":"stayed"');
  assert.equal(parsed.person_name, 'Ada');
  assert.equal(parsed.attachment.style, 'Secure');
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
  assert.equal(profile.big_five.openness.level, '');
  assert.match(profile.disclaimer, /DSM codes/);
});

test('normalizeProfile keeps Big Five, attachment, defenses, and relational dynamics', () => {
  const profile = normalizeProfile({
    person_name: 'Sam',
    big_five: { extraversion: { level: 'Low', manifestation: 'writes instead of calling', evidence: 'every entry is a letter' } },
    attachment: { style: 'Dismissive-Avoidant', relationship_pattern: 'pulls away when asked to stay', triggered_by: 'neediness' },
    defense_mechanisms: { primary: ['intellectualization'], under_stress: ['withdrawal'] },
    core_wound: 'left behind',
    coping_strategy: { adaptive: 'work', maladaptive: 'silence' },
    blind_spot: 'how much they want to be chosen',
    cognitive_distortions: [{ label: 'mind reading' }],
    relationships: [{
      name: 'Dad',
      nature: 'estranged',
      model: 'Attachment',
      power_dynamic: 'Complementary',
      unspoken_contract: 'do not ask',
      trigger_points: 'phone calls'
    }]
  });

  assert.equal(profile.big_five.extraversion.level, 'Low');
  assert.equal(profile.big_five.neuroticism.level, '');
  assert.equal(profile.attachment.style, 'Dismissive-Avoidant');
  assert.equal(profile.defense_mechanisms.primary[0].label, 'intellectualization');
  assert.equal(profile.core_wound.label, 'left behind');
  assert.equal(profile.coping_strategy.adaptive, 'work');
  assert.equal(profile.relationships[0].unspoken_contract, 'do not ask');
  assert.equal(profile.relationships[0].trigger_points, 'phone calls');
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
    fears: ['being a burden'],
    big_five: { extraversion: { level: 'Low', manifestation: 'writes instead of calling' } },
    attachment: { style: 'Dismissive-Avoidant', triggered_by: 'being needed' },
    core_wound: { label: 'left behind' }
  });

  assert.match(prompt, /You are Mara Quinn/);
  assert.match(prompt, /first person/);
  assert.match(prompt, /guarded/);
  assert.match(prompt, /self-reliance/);
  assert.match(prompt, /I already said no/);
  assert.match(prompt, /extraversion/);
  assert.match(prompt, /Dismissive-Avoidant/);
  assert.match(prompt, /left behind/);
});

test('normalizeMemories and mergeMemories keep source-grounded recall items', () => {
  const memories = normalizeMemories([
    'grew up by the lake',
    {
      type: 'event',
      title: 'Dad stopped calling',
      content: 'He stopped calling after the funeral.',
      when: 'the winter after',
      who: ['Dad'],
      importance: 'high',
      evidence: 'journal week 3'
    }
  ]);
  assert.equal(memories[0].type, 'fact');
  assert.equal(memories[1].type, 'event');
  assert.equal(memories[1].who[0], 'Dad');

  const merged = mergeMemories(memories, [
    { type: 'event', title: 'Dad stopped calling', content: 'He stopped calling after the funeral.' },
    { type: 'habit', title: 'writes after midnight', content: 'Every entry is timestamped past 12.' }
  ]);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].title, 'Dad stopped calling');
  assert.equal(merged[1].title, 'writes after midnight');
  assert.equal(merged[2].title, 'grew up by the lake');
});

test('formatMemoriesForModel is something the persona can reference', () => {
  const block = formatMemoriesForModel([
    { type: 'event', title: 'Dad stopped calling', content: 'He stopped calling after the funeral.', importance: 'high' }
  ]);
  assert.match(block, /Things you remember from your life/);
  assert.match(block, /Dad stopped calling/);
  assert.match(block, /do not invent extra biographical facts/i);
});

test('buildSystemPrompt includes extracted memories', () => {
  const prompt = buildSystemPrompt({
    person_name: 'Mara Quinn',
    summary: 'Sharp.',
    memories: [{ type: 'place', title: 'the lake house', content: 'Summers at the lake house.' }]
  });
  assert.match(prompt, /the lake house/);
  assert.match(prompt, /Things you remember/);
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

test('retrieveMemories ranks by query overlap', () => {
  const picked = retrieveMemories([
    { title: 'the lake house', content: 'Summers at the lake.', type: 'place' },
    { title: 'Dad stopped calling', content: 'He stopped calling after the funeral.', who: ['Dad'], type: 'event', importance: 'high' }
  ], 'what happened with your dad?');
  assert.equal(picked[0].title, 'Dad stopped calling');
});

test('contradictory memories are marked disputed instead of dropped', () => {
  const merged = mergeMemoriesWithConflicts(
    [{ type: 'fact', title: 'birthday', content: 'Born in June.' }],
    [{ type: 'fact', title: 'birthday', content: 'Born in January.' }]
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].disputed, true);
  assert.match(`${merged[0].content} ${merged[0].conflict}`, /June/);
  assert.match(`${merged[0].content} ${merged[0].conflict}`, /January/);
});

test('chunkDocuments splits long sources', () => {
  const chunks = chunkDocuments([{ filename: 'big.txt', text: 'abcdefghij'.repeat(1000) }], 500, 50);
  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].filename, 'big.txt');
});

test('mergeSystemPrompts keeps the persona and appends caller instructions', () => {
  const merged = mergeSystemPrompts('You are Mara.', 'Be brief.');
  assert.match(merged, /You are Mara/);
  assert.match(merged, /Be brief/);
  assert.match(merged, /do not break character/);
});

test('detectPerspective distinguishes first-person journals', () => {
  assert.equal(
    detectPerspective('I cannot sleep. I already said no. I did not tell Dad. My house ticks. I write at night. I keep my own counsel.'),
    'first-person'
  );
});

test('withMemoryIds is stable for the same content', () => {
  const [a] = withMemoryIds([{ type: 'event', title: 'x', content: 'y' }]);
  const [b] = withMemoryIds([{ type: 'event', title: 'x', content: 'y' }]);
  assert.equal(a.id, b.id);
  assert.match(PRIVACY_NOTICE, /permission/);
});

test('collectBodyDocuments accepts a transcript field', () => {
  const docs = collectBodyDocuments({ transcript: 'She said hello from the recording.' });
  assert.equal(docs[0].filename, 'transcript.txt');
  assert.match(docs[0].text, /recording/);
});
