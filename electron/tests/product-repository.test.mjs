import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openProductRepository } from '../product-repository.js';

function temporaryDatabase() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'scientia-repository-'));
  return { directory, databasePath: path.join(directory, 'product.sqlite3') };
}

function conversation(overrides = {}) {
  return {
    id: 'conversation-1',
    title: 'Reproducible evidence review',
    createdAt: '2026-11-17T00:00:00.000Z',
    updatedAt: '2026-11-17T00:05:00.000Z',
    messages: [
      { id: 'message-1', role: 'user', content: 'Review this claim.', createdAt: '2026-11-17T00:01:00.000Z' },
    ],
    activities: [],
    evidenceMode: true,
    researchMode: 'literature',
    ...overrides,
  };
}

test('conversations and active selection survive repository restart', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const original = conversation();

  const first = openProductRepository({ databasePath });
  first.createConversation(original);
  first.setActiveConversation(original.id);
  first.close();

  const reopened = openProductRepository({ databasePath });
  t.after(() => {
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const state = reopened.loadState();
  assert.equal(state.activeId, original.id);
  assert.deepEqual(state.conversations, [original]);
});

test('conversation updates and deletes are durable and keep a valid active selection', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const firstConversation = conversation();
  const secondConversation = conversation({
    id: 'conversation-2',
    title: 'Second research thread',
    createdAt: '2026-11-17T00:06:00.000Z',
    updatedAt: '2026-11-17T00:06:00.000Z',
  });

  let repository = openProductRepository({ databasePath });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  repository.createConversation(firstConversation);
  repository.createConversation(secondConversation);
  repository.updateConversation({
    ...firstConversation,
    title: 'Updated evidence review',
    updatedAt: '2026-11-17T00:10:00.000Z',
  });
  repository.setActiveConversation(secondConversation.id);
  repository.deleteConversation(secondConversation.id);
  repository.close();

  repository = openProductRepository({ databasePath });
  const state = repository.loadState();
  assert.equal(state.activeId, firstConversation.id);
  assert.equal(state.conversations.length, 1);
  assert.equal(state.conversations[0].title, 'Updated evidence review');
});

test('legacy browser conversations migrate once without duplication and keep the active selection', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const firstConversation = conversation();
  const secondConversation = conversation({
    id: 'conversation-2',
    title: 'Migrated active thread',
    createdAt: '2026-11-17T00:06:00.000Z',
    updatedAt: '2026-11-17T00:06:00.000Z',
  });

  const repository = openProductRepository({ databasePath });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const firstMigration = repository.migrateLegacyState({
    conversations: [firstConversation, secondConversation],
    activeId: secondConversation.id,
  });
  const secondMigration = repository.migrateLegacyState({
    conversations: [firstConversation, secondConversation],
    activeId: firstConversation.id,
  });

  assert.equal(firstMigration.migrated, true);
  assert.equal(secondMigration.migrated, false);
  assert.equal(secondMigration.activeId, secondConversation.id);
  assert.equal(secondMigration.conversations.length, 2);
});

test('conflicting duplicate IDs in legacy data are rejected instead of silently discarded', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const original = conversation();
  const conflicting = conversation({ title: 'Conflicting legacy version', updatedAt: '2026-11-17T00:20:00.000Z' });
  const repository = openProductRepository({ databasePath });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  assert.throws(() => repository.migrateLegacyState({
    conversations: [original, conflicting],
    activeId: original.id,
  }), /重复/);

  const state = repository.loadState();
  assert.equal(state.conversations.length, 0);
  assert.equal(state.migrationComplete, false);
});

test('legacy migration rejects a conflicting version of an existing repository conversation', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repositoryConversation = conversation({ title: 'Repository version' });
  const legacyConversation = conversation({ title: 'Legacy version' });
  const repository = openProductRepository({ databasePath });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  repository.createConversation(repositoryConversation);
  assert.throws(() => repository.migrateLegacyState({
    conversations: [legacyConversation],
    activeId: legacyConversation.id,
  }), /冲突/);

  const state = repository.loadState();
  assert.equal(state.migrationComplete, false);
  assert.equal(state.conversations[0].title, 'Repository version');
});
