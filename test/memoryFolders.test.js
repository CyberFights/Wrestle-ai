'use strict';

/*
 * Tests for memoryFolders.js — run with: npm test
 *
 * The folder-name mapping decides where each user's chats and facts live, so
 * the important properties are: names stay within MongoDB's 120-byte limit
 * (suffix included), the typed folders never collide with each other, and the
 * name predicates classify every layout correctly.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  collectionNameForUser,
  chatFolderNameForUser,
  factsFolderNameForUser,
  isUserFolderName,
  isChatFolderName,
  isFactsFolderName,
  CHAT_FOLDER_SUFFIX,
  FACTS_FOLDER_SUFFIX,
  CHAT_SCOPE,
  BATTLE_SCOPE,
  BATTLE_SCOPE_SUFFIX
} = require('../memoryFolders');

const MONGO_NAME_LIMIT = 120;

test('readable ids stay readable in both typed folders', () => {
  assert.equal(collectionNameForUser('12345'), 'memory_r_12345');
  assert.equal(chatFolderNameForUser('12345'), 'memory_r_12345_chats');
  assert.equal(factsFolderNameForUser('12345'), 'memory_r_12345_facts');
  assert.equal(collectionNameForUser('user-42_x'), 'memory_r_user-42_x');
});

test('unusual ids are base64url-encoded and both folders fit the name limit', () => {
  const id = 'user:öl/ strange \\/ id #';
  assert.match(collectionNameForUser(id), /^memory_b_[A-Za-z0-9_-]+$/);
  for (const name of [collectionNameForUser(id), chatFolderNameForUser(id), factsFolderNameForUser(id)]) {
    assert.ok(Buffer.byteLength(name, 'utf8') <= MONGO_NAME_LIMIT, `${name} must fit MongoDB's limit`);
  }
  // no padding / url-unsafe characters ever appear
  assert.doesNotMatch(collectionNameForUser(id), /[+/=]/);
});

test('very long ids fall back to a sha256 hash and still fit with suffixes', () => {
  const id = `x-${'a'.repeat(2000)}`;
  const base = collectionNameForUser(id);
  assert.match(base, /^memory_h_[0-9a-f]{64}$/);
  assert.ok(Buffer.byteLength(factsFolderNameForUser(id), 'utf8') <= MONGO_NAME_LIMIT);
  // deterministic
  assert.equal(collectionNameForUser(id), base);
});

test('folder names stay within the limit for the longest readable ids', () => {
  const id = 'a'.repeat(60);
  assert.equal(collectionNameForUser(id), `memory_r_${id}`);
  assert.ok(Buffer.byteLength(chatFolderNameForUser(id), 'utf8') <= MONGO_NAME_LIMIT);
  assert.ok(Buffer.byteLength(factsFolderNameForUser(id), 'utf8') <= MONGO_NAME_LIMIT);
});

test('a user always gets two different folders', () => {
  for (const id of ['12345', 'user-42', 'ö strange id', 'a'.repeat(500)]) {
    assert.notEqual(chatFolderNameForUser(id), factsFolderNameForUser(id));
  }
});

test('different users never share a folder', () => {
  const names = new Set();
  for (const id of ['alice', 'bob', 'alice2', 'ö strange', 'x'.repeat(500)]) {
    for (const name of [chatFolderNameForUser(id), factsFolderNameForUser(id)]) {
      assert.ok(!names.has(name), `${name} would be shared`);
      names.add(name);
    }
  }
});

test('name predicates classify typed and legacy folders', () => {
  assert.equal(isChatFolderName('memory_r_ann_chats'), true);
  assert.equal(isFactsFolderName('memory_r_ann_facts'), true);
  assert.equal(isChatFolderName('memory_r_ann_facts'), false);
  assert.equal(isFactsFolderName('memory_r_ann_chats'), false);

  // old, untyped single-folder layout
  assert.equal(isUserFolderName('memory_r_ann'), true);
  assert.equal(isChatFolderName('memory_r_ann'), false);
  assert.equal(isFactsFolderName('memory_r_ann'), false);

  // not our folders at all
  assert.equal(isUserFolderName('memory'), false);
  assert.equal(isUserFolderName('users'), false);
  assert.equal(isUserFolderName('memory_x_ann'), false);
  assert.equal(isChatFolderName('some_chats'), false);
  assert.equal(isUserFolderName(null), false);
});

test('typed names are built from the shared base', () => {
  for (const id of ['123', 'weird:id/×', 'q'.repeat(900)]) {
    const base = collectionNameForUser(id);
    assert.equal(chatFolderNameForUser(id), base + CHAT_FOLDER_SUFFIX);
    assert.equal(factsFolderNameForUser(id), base + FACTS_FOLDER_SUFFIX);
    assert.ok(isChatFolderName(chatFolderNameForUser(id)));
    assert.ok(isFactsFolderName(factsFolderNameForUser(id)));
  }
});

test('the chat scope keeps the original names; the battle scope appends a suffix', () => {
  for (const id of ['123', 'weird:id/×', 'q'.repeat(900)]) {
    const base = collectionNameForUser(id);
    assert.equal(chatFolderNameForUser(id, CHAT_SCOPE), base + CHAT_FOLDER_SUFFIX);
    assert.equal(factsFolderNameForUser(id, CHAT_SCOPE), base + FACTS_FOLDER_SUFFIX);
    assert.equal(chatFolderNameForUser(id, BATTLE_SCOPE), base + CHAT_FOLDER_SUFFIX + BATTLE_SCOPE_SUFFIX);
    assert.equal(factsFolderNameForUser(id, BATTLE_SCOPE), base + FACTS_FOLDER_SUFFIX + BATTLE_SCOPE_SUFFIX);
    assert.ok(Buffer.byteLength(chatFolderNameForUser(id, BATTLE_SCOPE), 'utf8') <= MONGO_NAME_LIMIT);
    assert.ok(Buffer.byteLength(factsFolderNameForUser(id, BATTLE_SCOPE), 'utf8') <= MONGO_NAME_LIMIT);
  }
});

test('scoped folders never collide across users or endpoints', () => {
  const names = new Set();
  for (const id of ['alice', 'bob']) {
    for (const scope of [CHAT_SCOPE, BATTLE_SCOPE]) {
      const pair = [chatFolderNameForUser(id, scope), factsFolderNameForUser(id, scope)];
      assert.notEqual(pair[0], pair[1]);
      for (const name of pair) {
        assert.ok(!names.has(name), `${name} would be shared`);
        names.add(name);
      }
    }
  }
});

test('name predicates classify the battle-scoped folders', () => {
  assert.equal(isChatFolderName('memory_r_ann_chats_battle'), true);
  assert.equal(isFactsFolderName('memory_r_ann_facts_battle'), true);
  assert.equal(isChatFolderName('memory_r_ann_facts_battle'), false);
  assert.equal(isFactsFolderName('memory_r_ann_chats_battle'), false);
  assert.equal(isChatFolderName('memory_r_ann_chats'), true);
  assert.equal(isFactsFolderName('memory_r_ann_facts'), true);
});
