import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { openProductRepository } from '../product-repository.js';

function temporaryDatabase() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'scientia-repository-'));
  return { directory, databasePath: path.join(directory, 'product.sqlite3') };
}

function openTestRepository(databasePath) {
  const repository = openProductRepository({ databasePath });
  repository.ensureProject({ workspacePath: 'C:/Research/Test Project' });
  return repository;
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

  const first = openTestRepository(databasePath);
  first.createConversation(original);
  first.setActiveConversation(original.id);
  first.close();

  const reopened = openTestRepository(databasePath);
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

  let repository = openTestRepository(databasePath);
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

  repository = openTestRepository(databasePath);
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

  const repository = openTestRepository(databasePath);
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
  const repository = openTestRepository(databasePath);
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
  const repository = openTestRepository(databasePath);
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

test('conversations stay bound to their project workspace', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const project = repository.ensureProject({ workspacePath: 'C:/Research/Project-A' });
  repository.createConversation(conversation());

  assert.equal(project.workspacePath, 'C:/Research/Project-A');
  assert.equal(repository.rebindWorkspace, undefined);
  assert.equal(repository.loadState().project.workspacePath, 'C:/Research/Project-A');
});

test('conversations require a workspace-bound project', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openProductRepository({ databasePath });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  assert.throws(() => repository.createConversation(conversation()), /尚未绑定研究工作区/);
});

test('projects own isolated conversations and each project keeps its own active conversation', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const firstProject = repository.loadState().project;
  const firstConversation = conversation();
  repository.createConversation(firstConversation);
  repository.setActiveConversation(firstConversation.id);

  const secondProject = repository.createProject({
    id: 'project-2',
    name: 'Second Research Question',
    workspacePath: 'C:/Research/Second-Project',
    workspaceKind: 'imported',
  });
  const secondConversation = conversation({
    id: 'conversation-2',
    title: 'Second project thread',
    createdAt: '2026-11-17T00:06:00.000Z',
    updatedAt: '2026-11-17T00:06:00.000Z',
  });
  repository.createConversation(secondConversation);
  repository.setActiveConversation(secondConversation.id);

  let state = repository.loadState();
  assert.equal(state.activeProjectId, secondProject.id);
  assert.equal(state.project.workspacePath, 'C:/Research/Second-Project');
  assert.deepEqual(state.conversations, [secondConversation]);
  assert.equal(state.activeId, secondConversation.id);

  repository.setActiveProject(firstProject.id);
  state = repository.loadState();
  assert.equal(state.activeProjectId, firstProject.id);
  assert.equal(state.project.workspacePath, 'C:/Research/Test Project');
  assert.deepEqual(state.conversations, [firstConversation]);
  assert.equal(state.activeId, firstConversation.id);

  repository.setActiveProject(secondProject.id);
  assert.equal(repository.loadState().activeId, secondConversation.id);
});

test('conversation mutations cannot cross the active project boundary', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const firstProject = repository.loadState().project;
  const firstConversation = conversation();
  repository.createConversation(firstConversation);
  repository.createProject({
    id: 'project-2',
    name: 'Other project',
    workspacePath: 'C:/Research/Other-Project',
    workspaceKind: 'managed',
  });

  assert.throws(() => repository.updateConversation(firstConversation), /不存在的会话/);
  assert.throws(() => repository.deleteConversation(firstConversation.id), /不存在的会话/);
  assert.throws(() => repository.setActiveConversation(firstConversation.id), /不存在的会话/);

  repository.setActiveProject(firstProject.id);
  assert.deepEqual(repository.loadState().conversations, [firstConversation]);
});

test('projects cannot share one research workspace', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  assert.throws(() => repository.createProject({
    id: 'project-2',
    name: 'Duplicate workspace',
    workspacePath: 'c:/research/test project',
    workspaceKind: 'imported',
  }), /目录重叠/);
});

test('nested workspaces cannot be bound to different projects', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  assert.throws(() => repository.createProject({
    id: 'project-child',
    name: 'Nested workspace',
    workspacePath: 'C:/Research/Test Project/child',
    workspaceKind: 'imported',
  }), /目录重叠/);
});

test('a parent workspace cannot later contain an existing project workspace', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  assert.throws(() => repository.createProject({
    id: 'project-parent',
    name: 'Parent workspace',
    workspacePath: 'C:/Research',
    workspaceKind: 'imported',
  }), /目录重叠/);
});

test('archive is reversible and leaves project conversations intact', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const archivedConversation = conversation();
  repository.createConversation(archivedConversation);
  const projectId = repository.loadState().activeProjectId;
  const archivedProject = repository.archiveProject(projectId);
  assert.equal(archivedProject.id, projectId);
  assert.ok(archivedProject.archivedAt);
  assert.equal(repository.loadState().archivedProjects.some((project) => project.id === archivedProject.id), true);
  assert.throws(() => repository.setActiveProject(archivedProject.id), /已归档/);

  const restored = repository.restoreProject(archivedProject.id);
  assert.equal(restored.archivedAt, null);
  assert.equal(repository.loadState().activeProjectId, archivedProject.id);
  assert.deepEqual(repository.loadState().conversations, [archivedConversation]);
});

test('restoring an archived project does not steal focus from the active project', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const firstProject = repository.loadState().project;
  const archivedProject = repository.createProject({
    id: 'project-2',
    name: 'Archived without focus',
    workspacePath: 'C:/Research/Archived-Project',
    workspaceKind: 'imported',
  });
  repository.archiveProject(archivedProject.id);
  assert.equal(repository.loadState().activeProjectId, firstProject.id);

  repository.restoreProject(archivedProject.id);
  assert.equal(repository.loadState().activeProjectId, firstProject.id);
  assert.equal(repository.loadState().projects.find((project) => project.id === archivedProject.id).archivedAt, null);
});

test('legacy active conversation is scoped to its project before another project can replace the global value', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const firstConversation = conversation();
  const secondConversation = conversation({
    id: 'conversation-2',
    title: 'Second legacy thread',
    createdAt: '2026-11-17T00:06:00.000Z',
    updatedAt: '2026-11-17T00:06:00.000Z',
  });
  let repository = openTestRepository(databasePath);
  const projectId = repository.loadState().activeProjectId;
  repository.createConversation(firstConversation);
  repository.createConversation(secondConversation);
  repository.setActiveConversation(firstConversation.id);
  repository.close();

  const database = new DatabaseSync(databasePath);
  database.prepare("DELETE FROM app_state WHERE key LIKE 'active_conversation_id:%'").run();
  database.close();

  repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(repository.loadState().activeId, firstConversation.id);
  repository.createProject({
    id: 'project-2',
    name: 'Replacement project',
    workspacePath: 'C:/Research/Replacement-Project',
    workspaceKind: 'managed',
  });
  repository.setActiveProject(projectId);
  assert.equal(repository.loadState().activeId, firstConversation.id);
});

test('project deletion requires the exact project name and removes only project-owned records', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const project = repository.createProject({
    id: 'project-2',
    name: 'Delete Me Exactly',
    workspacePath: 'C:/Research/Delete-Me',
    workspaceKind: 'imported',
  });
  repository.createConversation(conversation());

  assert.throws(() => repository.deleteProject({ id: project.id, confirmationName: 'delete me exactly' }), /项目名称/);
  assert.equal(repository.loadState().activeProjectId, project.id);

  const result = repository.deleteProject({ id: project.id, confirmationName: 'Delete Me Exactly' });
  assert.equal(result.deletedProject.id, project.id);
  assert.notEqual(repository.loadState().activeProjectId, project.id);
  assert.equal(repository.loadState().projects.some((item) => item.id === project.id), false);
  assert.equal(repository.loadState().conversations.length, 0);
});
