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
  repository.bindPendingBootstrapResearchProject({ workspacePath: 'C:/Research/Test Project' });
  return repository;
}

function charter(overrides = {}) {
  return {
    question: 'How reproducible is the reported effect?',
    contribution: 'Clarify the strength and limits of the available evidence.',
    scope: 'Peer-reviewed studies available in the project workspace.',
    methodConstraints: 'Preserve source locators and distinguish observations from inference.',
    successCriteria: 'A traceable evidence record and a defensible research brief.',
    paperType: 'Review',
    citationStyle: 'Vancouver',
    dataPolicy: 'standard',
    ...overrides,
  };
}

function approveTestCharter(repository, overrides = {}) {
  const fields = charter(overrides);
  repository.saveResearchCharterDraft({
    charter: fields,
    revisionOrigin: 'agent',
    generatedByRunId: 'test-agent-draft',
  });
  return repository.approveResearchCharter({ charter: fields });
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
    activeSourceIds: [],
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

  const project = repository.createProject({
    id: 'project-a',
    name: 'Project A',
    workspacePath: 'C:/Research/Project-A',
    workspaceKind: 'imported',
  });
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

  assert.throws(() => repository.createConversation(conversation()), /尚未绑定 Research Workspace/);
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
  assert.equal(repository.loadState().projects.filter((project) => project.archivedAt).some((project) => project.id === archivedProject.id), true);
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

test('deleting the bootstrapped default project is durable across repository restarts', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  let repository = openProductRepository({ databasePath });
  repository.bindPendingBootstrapResearchProject({ workspacePath: 'C:/Research/Default-Project' });
  const defaultProject = repository.loadState().project;
  repository.deleteProject({
    id: defaultProject.id,
    confirmationName: defaultProject.name,
  });
  repository.close();

  repository = openProductRepository({ databasePath });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.deepEqual(repository.loadState().projects, []);
  assert.equal(repository.loadState().activeProjectId, null);
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

test('the pending bootstrap record is not exposed as a Research Project', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openProductRepository({ databasePath });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const pendingState = repository.loadState();

  assert.equal(pendingState.requiresResearchWorkspaceBinding, true);
  assert.equal(pendingState.activeProjectId, null);
  assert.deepEqual(pendingState.projects, []);
  assert.equal(repository.getProject('scientia-default-project'), null);
});

test('the repository exposes canonical and protected Research Workspace paths', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const alpha = repository.loadState().project;
  const beta = repository.createProject({
    id: 'research-project-beta',
    name: 'Beta',
    workspacePath: 'C:/Research/Beta',
    workspaceKind: 'imported',
  });

  assert.equal(repository.getActiveResearchWorkspacePath(), beta.workspacePath);
  assert.deepEqual(
    new Set(repository.getBoundResearchWorkspacePaths()),
    new Set([alpha.workspacePath, beta.workspacePath]),
  );
});

test('whitespace-only Research Workspace paths are unbound in queries and lookups', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  let repository = openProductRepository({ databasePath });
  t.after(() => {
    repository?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  repository.close();
  const database = new DatabaseSync(databasePath);
  database.prepare("UPDATE projects SET workspace_path = '   ' WHERE id = 'scientia-default-project'").run();
  database.close();
  repository = openProductRepository({ databasePath });

  const state = repository.loadState();
  assert.equal(state.requiresResearchWorkspaceBinding, true);
  assert.deepEqual(state.projects, []);
  assert.equal(repository.getProject('scientia-default-project'), null);
});


test('checkpoint decisions persist across repository restarts', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  let repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const checkpoint = repository.recordCheckpoint({
    type: 'external-transmission',
    decision: 'approved',
    rationale: 'User confirmed sensitive external transmission.',
    metadata: { charterVersion: 2, dataPolicy: 'sensitive' },
  });
  assert.match(checkpoint.id, /^[a-f0-9-]{36}$/);
  assert.equal(checkpoint.decision, 'approved');

  repository.close();
  repository = openTestRepository(databasePath);
  const checkpoints = repository.listCheckpoints();
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].type, 'external-transmission');
  assert.equal(checkpoints[0].metadata.charterVersion, 2);
});

test('research stages persist completed and not-applicable state across restarts', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  let repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const initial = repository.loadState().project.stageGraph;
  assert.equal(initial.currentStageKey, 'scoping');
  assert.deepEqual(
    initial.stages.map((stage) => stage.englishLabel),
    ['Scoping', 'Evidence', 'Inquiry', 'Synthesis', 'Manuscript', 'Release'],
  );
  assert.match(initial.stages[1].lockReason, /Scoping/);

  approveTestCharter(repository);
  repository.markResearchStageNotApplicable({
    stageKey: 'evidence',
    reason: 'This manuscript uses only project-generated simulation data.',
  });
  const beforeRestart = repository.loadState().project.stageGraph;
  assert.equal(beforeRestart.currentStageKey, 'inquiry');
  assert.equal(beforeRestart.stages[0].status, 'completed');
  assert.equal(beforeRestart.stages[1].status, 'not-applicable');
  assert.equal(beforeRestart.stages[1].notApplicableReason, 'This manuscript uses only project-generated simulation data.');
  assert.match(beforeRestart.nextAction.description, /Synthesis/);
  repository.close();

  repository = openTestRepository(databasePath);
  const restored = repository.loadState().project.stageGraph;
  assert.equal(restored.currentStageKey, 'inquiry');
  assert.equal(restored.stages[0].status, 'completed');
  assert.equal(restored.stages[1].status, 'not-applicable');
  assert.equal(restored.stages[1].notApplicableReason, 'This manuscript uses only project-generated simulation data.');
  assert.equal(restored.progress.completed, 1);
  assert.equal(restored.progress.notApplicable, 1);
});


test('legacy Scoping skips cannot bypass the approved Charter gate', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const first = openTestRepository(databasePath);
  const projectId = first.loadState().activeProjectId;
  first.close();

  const timestamp = '2026-11-18T10:00:00.000Z';
  const database = new DatabaseSync(databasePath);
  database.prepare(`
    UPDATE projects
    SET current_stage_key = 'evidence', research_stage_states_json = ?
    WHERE id = ?
  `).run(JSON.stringify({
    scoping: {
      status: 'not-applicable',
      updatedAt: timestamp,
      notApplicableReason: 'Legacy skipped Scoping.',
    },
  }), projectId);
  database.close();

  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const state = repository.loadState();
  assert.equal(state.project.charter.approved, null);
  assert.equal(state.project.stageGraph.currentStageKey, 'scoping');
  assert.throws(() => repository.completeResearchStage('evidence'), /当前阶段/);
});

test('research stage state is project-scoped and completed stages can be revisited', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const initialProjectId = repository.loadState().activeProjectId;
  approveTestCharter(repository);
  repository.completeResearchStage('evidence');

  const otherProject = repository.createProject({
    id: 'project-stage-isolation',
    name: 'Stage Isolation',
    workspacePath: 'C:/Research/Stage-Isolation',
    workspaceKind: 'imported',
  });
  assert.equal(repository.loadState().project.stageGraph.currentStageKey, 'scoping');

  repository.setActiveProject(initialProjectId);
  const original = repository.loadState().project;
  assert.equal(original.stageGraph.currentStageKey, 'inquiry');
  assert.equal(original.stageGraph.stages[1].status, 'completed');

  repository.reopenResearchStage('evidence');
  const reopened = repository.loadState().project.stageGraph;
  assert.equal(reopened.currentStageKey, 'evidence');
  assert.equal(reopened.currentStage.isCompleted, true);
  assert.deepEqual(reopened.nextAction.allowedActions, ['complete']);

  repository.setActiveProject(otherProject.id);
  assert.equal(repository.loadState().project.stageGraph.currentStageKey, 'scoping');
});

test('research stage mutations reject invalid transitions and missing skip reasons', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  assert.throws(() => repository.completeResearchStage('evidence'), /当前阶段/);
  assert.throws(() => repository.completeResearchStage('unknown'), /阶段/);
  assert.throws(() => repository.markResearchStageNotApplicable({ stageKey: 'scoping', reason: '   ' }), /Charter/);
  assert.throws(() => repository.reopenResearchStage('scoping'), /Evidence/);
});

test('the complete stage graph reaches a durable terminal state', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  let repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  approveTestCharter(repository);
  for (const key of ['evidence', 'inquiry', 'synthesis', 'manuscript', 'release']) {
    repository.completeResearchStage(key);
  }
  assert.equal(repository.loadState().project.stageGraph.currentStageKey, null);
  assert.equal(repository.loadState().project.stageGraph.progress.completed, 6);
  repository.close();

  repository = openTestRepository(databasePath);
  const restored = repository.loadState().project.stageGraph;
  assert.equal(restored.currentStageKey, null);
  assert.equal(restored.stages.every((stage) => stage.status === 'completed'), true);
  assert.equal(restored.nextAction.type, 'complete');
});

test('corrupt stage records cannot leave a later stage current without its prerequisites', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const first = openTestRepository(databasePath);
  const projectId = first.loadState().activeProjectId;
  first.close();

  const database = new DatabaseSync(databasePath);
  database.prepare(`
    UPDATE projects
    SET current_stage_key = 'release', research_stage_states_json = '{broken json'
    WHERE id = ?
  `).run(projectId);
  database.close();

  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const graph = repository.loadState().project.stageGraph;
  assert.equal(graph.currentStageKey, 'scoping');
  assert.equal(graph.stages[0].status, 'current');
  assert.equal(graph.stages[5].status, 'pending');
  assert.match(graph.stages[5].lockReason, /Scoping/);
});

test('partial stage records recover to a coherent ordered graph', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const first = openTestRepository(databasePath);
  const projectId = first.loadState().activeProjectId;
  approveTestCharter(first);
  first.close();

  const timestamp = '2026-11-18T10:00:00.000Z';
  const partialStages = {
    scoping: { status: 'completed', updatedAt: timestamp, completedAt: timestamp, notApplicableReason: null },
    manuscript: { status: 'completed', updatedAt: timestamp, completedAt: timestamp, notApplicableReason: null },
    release: { status: 'completed', updatedAt: timestamp, completedAt: timestamp, notApplicableReason: null },
  };
  const database = new DatabaseSync(databasePath);
  database.prepare(`
    UPDATE projects
    SET current_stage_key = 'release', research_stage_states_json = ?
    WHERE id = ?
  `).run(JSON.stringify(partialStages), projectId);
  database.close();

  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const graph = repository.loadState().project.stageGraph;
  assert.equal(graph.currentStageKey, 'evidence');
  assert.equal(graph.stages[0].status, 'completed');
  assert.equal(graph.stages[1].status, 'current');
  assert.equal(graph.stages[4].status, 'pending');
  assert.equal(graph.stages[5].status, 'pending');
  assert.match(graph.stages[4].lockReason, /Evidence/);
});

test('Scoping cannot advance or be skipped without an approved Research Charter', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const initial = repository.loadState().project;
  assert.equal(initial.charter.current, null);
  assert.equal(initial.stageGraph.nextAction.type, 'charter');
  assert.deepEqual(initial.stageGraph.nextAction.allowedActions, ['review-charter']);
  assert.throws(() => repository.completeResearchStage('scoping'), /Charter/);
  assert.throws(
    () => repository.markResearchStageNotApplicable({ stageKey: 'scoping', reason: 'Not needed.' }),
    /Charter/,
  );

  let state = repository.saveResearchCharterDraft({ charter: charter(), revisionOrigin: 'agent', generatedByRunId: 'run-scoping-1' });
  assert.equal(state.project.charter.current.version, 1);
  assert.equal(state.project.charter.current.status, 'draft');
  assert.equal(state.project.charter.current.revisionOrigin, 'agent');
  assert.equal(state.project.charter.current.generatedByRunId, 'run-scoping-1');
  assert.match(state.project.charter.current.contentHash, /^[a-f0-9]{64}$/);
  assert.throws(() => repository.completeResearchStage('scoping'), /Charter/);

  state = repository.approveResearchCharter({ charter: charter() });
  assert.equal(state.project.stageGraph.currentStageKey, 'evidence');
  assert.equal(state.project.charter.current.status, 'approved');
  assert.equal(state.project.charter.approved.version, 2);
  assert.equal(state.project.stageGraph.stages[0].status, 'completed');
  assert.equal(state.project.stageGraph.stages[0].charterVersion, 2);
  assert.equal(state.project.charter.current.generatedByRunId, 'run-scoping-1');
  assert.match(state.project.charter.current.contentHash, /^[a-f0-9]{64}$/);
});


test('Research Charter approval requires an agent-drafted revision', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const fields = charter();
  repository.saveResearchCharterDraft({ charter: fields, revisionOrigin: 'user' });

  assert.throws(
    () => repository.approveResearchCharter({ charter: fields }),
    /Science Agent/,
  );
  assert.equal(repository.loadState().project.stageGraph.currentStageKey, 'scoping');
});

test('editing an approved Research Charter creates a revision and requires re-approval', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  approveTestCharter(repository);
  repository.completeResearchStage('evidence');
  assert.equal(repository.loadState().project.stageGraph.currentStageKey, 'inquiry');

  const revised = charter({ question: 'Which protocol has the strongest reproducibility evidence?' });
  let state = repository.saveResearchCharterDraft({ charter: revised, revisionOrigin: 'user' });

  assert.equal(state.project.stageGraph.currentStageKey, 'scoping');
  assert.equal(state.project.stageGraph.stages[1].status, 'completed');
  assert.equal(state.project.charter.revisions.length, 3);
  assert.equal(state.project.charter.revisions[1].status, 'approved');
  assert.equal(state.project.charter.current.version, 3);
  assert.equal(state.project.charter.current.status, 'draft');
  assert.equal(state.project.charter.needsReapproval, true);
  assert.equal(state.project.charter.approved, null);
  assert.equal(state.project.stageGraph.stages[1].canReopen, false);
  assert.throws(() => repository.completeResearchStage('scoping'), /Charter/);
  assert.throws(() => repository.reopenResearchStage('evidence'), /Charter|Scoping/);
  assert.equal(repository.loadState().project.stageGraph.currentStageKey, 'scoping');

  state = repository.approveResearchCharter({ charter: revised });
  assert.equal(state.project.stageGraph.currentStageKey, 'inquiry');
  assert.equal(state.project.stageGraph.stages[0].charterVersion, 4);
  assert.equal(state.project.charter.current.version, 4);
  assert.equal(state.project.charter.current.status, 'approved');
  assert.equal(state.project.charter.revisions[1].version, 2);
  assert.equal(state.project.charter.revisions[1].status, 'approved');
});


test('a retained Research Charter revision can be restored as a new draft', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  approveTestCharter(repository);
  const userRevision = charter({ question: 'The user pending revision.' });
  repository.saveResearchCharterDraft({ charter: userRevision, revisionOrigin: 'user' });
  repository.saveResearchCharterDraft({
    charter: charter({ question: 'The later agent revision.' }),
    revisionOrigin: 'agent',
    generatedByRunId: 'run-later-agent-draft',
  });

  const state = repository.restoreResearchCharterRevision({ version: 3 });
  assert.equal(state.project.charter.current.version, 5);
  assert.equal(state.project.charter.current.status, 'draft');
  assert.equal(state.project.charter.current.question, 'The user pending revision.');
  assert.equal(state.project.charter.current.supersedes, 4);
  assert.equal(state.project.charter.revisions.find((revision) => revision.version === 3).question, 'The user pending revision.');
});

test('approved Research Charter revisions survive repository restart for later runs', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  let repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const fields = charter({ dataPolicy: 'sensitive', citationStyle: 'APA 7' });
  repository.saveResearchCharterDraft({
    charter: fields,
    revisionOrigin: 'agent',
    generatedByRunId: 'run-restart-charter',
  });
  repository.approveResearchCharter({ charter: fields });
  repository.close();

  repository = openTestRepository(databasePath);
  const project = repository.loadState().project;
  assert.equal(project.stageGraph.currentStageKey, 'evidence');
  assert.equal(project.charter.approved.version, 2);
  assert.equal(project.charter.approved.dataPolicy, 'sensitive');
  assert.equal(project.charter.approved.citationStyle, 'APA 7');
});

function resolveSourceRemoval(repository, id) {
  const pending = repository.beginCheckpoint({
    type: 'source-removal',
    rationale: 'Remove the source record.',
    metadata: { sourceId: id },
  });
  return repository.resolveSourceCheckpoint({
    id: pending.id,
    decision: 'approved',
    rationale: 'User approved Source removal.',
  });
}

function resolveSourceRevision(repository, id, contentHash) {
  const pending = repository.beginCheckpoint({
    type: 'source-revision-accepted',
    rationale: 'Accept the observed revision.',
    metadata: { sourceId: id, observedContentHash: contentHash },
  });
  return repository.resolveSourceCheckpoint({
    id: pending.id,
    decision: 'approved',
    rationale: 'User accepted the observed revision.',
  });
}

function sourceVerification(contentHash = 'a'.repeat(64)) {
  return {
    locator: 'line:3',
    quote: 'Supported result.',
    claim: 'The result is supported.',
    contentHash,
  };
}

function sourceRecord(overrides = {}) {
  return {
    id: 'source-1',
    kind: 'markdown',
    title: 'A Reproducible Trial',
    authors: ['Jane Smith'],
    year: 2023,
    doi: '10.1000/trial',
    url: null,
    venue: 'Journal of Reproducibility',
    stableIdentifier: 'doi:10.1000/trial',
    localLocator: '.science/sources/trial.md',
    contentHash: 'a'.repeat(64),
    acquiredAt: '2026-11-19T12:00:00.000Z',
    metadata: { importedBy: 'test' },
    ...overrides,
  };
}

test('project source library persists records and suppresses stable-identifier duplicates', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const first = repository.registerSources({ sources: [sourceRecord()] });
  assert.equal(first.inserted.length, 1);
  assert.equal(first.duplicates.length, 0);

  const duplicate = repository.registerSources({
    sources: [sourceRecord({
      id: 'source-duplicate',
      title: 'Trial with a revised title',
      localLocator: '.science/sources/duplicate.md',
      contentHash: 'b'.repeat(64),
    })],
  });
  assert.equal(duplicate.inserted.length, 0);
  assert.equal(duplicate.duplicates.length, 1);
  assert.equal(duplicate.duplicates[0].existing.id, 'source-1');

  const state = repository.loadState();
  assert.equal(state.sources.length, 1);
  assert.equal(state.sources[0].title, 'A Reproducible Trial');
  assert.equal(state.sources[0].contentHash, 'a'.repeat(64));
});

test('normalized title and year detect duplicates when no stable identifier exists', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  repository.registerSources({
    sources: [sourceRecord({ stableIdentifier: 'file:first.md', doi: null })],
  });
  const result = repository.registerSources({
    sources: [sourceRecord({
      id: 'source-title-duplicate',
      title: '  A reproducible   trial ',
      stableIdentifier: 'file:second.md',
      doi: null,
      localLocator: '.science/sources/second.md',
      contentHash: 'c'.repeat(64),
    })],
  });

  assert.equal(result.inserted.length, 0);
  assert.equal(result.duplicates[0].existing.id, 'source-1');
  assert.equal(repository.loadState().sources.length, 1);
});

test('conversation active source sets persist and reject sources from another project', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const projectAConversation = conversation({ id: 'conversation-a' });
  repository.createConversation(projectAConversation);
  repository.registerSources({ sources: [sourceRecord()] });
  repository.setActiveSources({
    conversationId: projectAConversation.id,
    sourceIds: ['source-1'],
  });

  assert.deepEqual(repository.getConversationActiveSourceIds(projectAConversation.id), ['source-1']);
  assert.deepEqual(
    repository.getConversationActiveSources(projectAConversation.id).map((source) => source.id),
    ['source-1'],
  );

  repository.createProject({
    id: 'project-b',
    name: 'Second Project',
    workspacePath: 'C:/Research/Second Project',
    workspaceKind: 'imported',
  });
  const projectBConversation = conversation({ id: 'conversation-b', title: 'Second project conversation' });
  repository.createConversation(projectBConversation);
  repository.registerSources({
    sources: [sourceRecord({
      id: 'source-b',
      title: 'Second project source',
      doi: '10.1000/second',
      stableIdentifier: 'doi:10.1000/second',
      localLocator: '.science/sources/second.md',
      contentHash: 'd'.repeat(64),
    })],
  });

  assert.throws(() => repository.setActiveSources({
    conversationId: projectAConversation.id,
    sourceIds: ['source-b'],
  }), /当前 Research Project/);
  assert.throws(() => repository.setActiveSources({
    conversationId: projectBConversation.id,
    sourceIds: ['source-1'],
  }), /不属于当前 Research Project/);
  assert.throws(() => repository.getConversationActiveSources(projectAConversation.id), /当前 Research Project/);
  assert.equal(repository.getSource('source-1'), null);
  assert.equal(repository.getSource('source-b')?.id, 'source-b');
});

test('adding a source after Evidence revokes freeze by returning the project to Evidence', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  approveTestCharter(repository);
  repository.completeResearchStage('evidence');
  assert.equal(repository.loadState().project.stageGraph.currentStageKey, 'inquiry');

  repository.registerSources({ sources: [sourceRecord()] });
  const stageGraph = repository.loadState().project.stageGraph;
  assert.equal(stageGraph.currentStageKey, 'evidence');
  assert.equal(stageGraph.currentStage.isCompleted, true);
  assert.deepEqual(stageGraph.nextAction.allowedActions, ['complete']);
});

test('source records initialize verification and freshness states', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  let repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  repository.registerSources({ sources: [sourceRecord()] });
  assert.equal(repository.getSource('source-1').verificationState, 'unverified');
  assert.equal(repository.getSource('source-1').freshnessState, 'current');

  repository.close();
  repository = openTestRepository(databasePath);
  assert.equal(repository.getSource('source-1').verificationState, 'unverified');
  assert.equal(repository.getSource('source-1').freshnessState, 'current');
});

test('source records preserve BibTeX and CSL JSON metadata', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  let repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  repository.registerSources({
    sources: [sourceRecord({
      id: 'source-bibtex',
      kind: 'bibtex',
      citekey: 'smith2024',
      bibtex: '@article{smith2024, title={A Reproducible Trial}, year={2023}}',
      cslJson: {
        type: 'article-journal',
        title: 'A Reproducible Trial',
        DOI: '10.1000/trial',
        issued: { 'date-parts': [[2023]] },
      },
    })],
  });
  repository.close();
  repository = openTestRepository(databasePath);

  const source = repository.getSource('source-bibtex');
  assert.match(source.bibtex, /@article\{smith2024/);
  assert.deepEqual(source.cslJson, {
    type: 'article-journal',
    title: 'A Reproducible Trial',
    DOI: '10.1000/trial',
    issued: { 'date-parts': [[2023]] },
  });
});

test('conversation updates cannot bypass Active Source Set ownership validation', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const firstConversation = conversation({ id: 'source-owner-conversation' });
  repository.createConversation(firstConversation);
  repository.registerSources({ sources: [sourceRecord()] });

  repository.createProject({
    id: 'source-owner-project-b',
    name: 'Source Owner Project B',
    workspacePath: 'C:/Research/Source Owner B',
    workspaceKind: 'imported',
  });
  const secondConversation = conversation({ id: 'source-owner-conversation-b', title: 'Project B conversation' });
  repository.createConversation(secondConversation);

  assert.throws(() => repository.updateConversation({
    ...secondConversation,
    activeSourceIds: ['source-1'],
  }), /不属于当前 Research Project/);
  assert.deepEqual(repository.loadState().conversations.find((item) => item.id === secondConversation.id).activeSourceIds, []);
});
test('conversation creation rejects Active Source IDs from another project', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  repository.registerSources({ sources: [sourceRecord()] });
  repository.createProject({
    id: 'source-create-project-b',
    name: 'Source Create Project B',
    workspacePath: 'C:/Research/Source Create B',
    workspaceKind: 'imported',
  });

  assert.throws(() => repository.createConversation(conversation({
    id: 'source-create-conversation-b',
    activeSourceIds: ['source-1'],
  })), /不属于当前 Research Project/);
  assert.equal(repository.loadState().conversations.some((item) => item.id === 'source-create-conversation-b'), false);
});

test('removing a source clears active sets and revokes Evidence Freeze', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const activeConversation = conversation({ id: 'conversation-remove-source' });
  repository.createConversation(activeConversation);
  repository.registerSources({ sources: [sourceRecord()] });
  repository.setActiveSources({
    conversationId: activeConversation.id,
    sourceIds: ['source-1'],
  });
  approveTestCharter(repository);
  repository.completeResearchStage('evidence');
  assert.equal(repository.loadState().project.stageGraph.currentStageKey, 'inquiry');

  const state = resolveSourceRemoval(repository, 'source-1');
  assert.equal(state.sources.some((source) => source.id === 'source-1'), false);
  assert.deepEqual(
    state.conversations.find((item) => item.id === activeConversation.id).activeSourceIds,
    [],
  );
  assert.equal(state.project.stageGraph.currentStageKey, 'evidence');
});

test('source integrity refresh marks changed content stale and revokes Evidence Freeze', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  repository.registerSources({ sources: [sourceRecord()] });
  repository.setSourceVerification({ id: 'source-1', verificationState: 'verified', verification: sourceVerification() });
  assert.equal(repository.getSource('source-1').verificationState, 'verified');
  assert.equal(repository.getSource('source-1').freshnessState, 'current');

  repository.refreshSourceIntegrity({ id: 'source-1', contentHash: 'a'.repeat(64) });
  assert.equal(repository.getSource('source-1').verificationState, 'verified');
  assert.equal(repository.getSource('source-1').freshnessState, 'current');

  approveTestCharter(repository);
  repository.completeResearchStage('evidence');
  const changed = repository.refreshSourceIntegrity({ id: 'source-1', contentHash: 'b'.repeat(64) });
  const source = changed.sources.find((item) => item.id === 'source-1');
  assert.equal(source.freshnessState, 'stale');
  assert.equal(source.verificationState, 'unverified');
  assert.equal(source.contentHash, 'a'.repeat(64));
  assert.equal(source.observedContentHash, 'b'.repeat(64));
  assert.match(source.metadata.evidenceInvalidBefore, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(changed.project.stageGraph.currentStageKey, 'evidence');

  const refreshedAgain = repository.refreshSourceIntegrity({ id: 'source-1', contentHash: 'b'.repeat(64) });
  const stillStale = refreshedAgain.sources.find((item) => item.id === 'source-1');
  assert.equal(stillStale.freshnessState, 'stale');
  assert.equal(stillStale.verificationState, 'unverified');
  assert.equal(stillStale.contentHash, 'a'.repeat(64));

  const accepted = resolveSourceRevision(repository, 'source-1', 'b'.repeat(64));
  const acceptedSource = accepted.sources.find((item) => item.id === 'source-1');
  assert.equal(acceptedSource.freshnessState, 'current');
  assert.equal(acceptedSource.verificationState, 'unverified');
  assert.equal(acceptedSource.contentHash, 'a'.repeat(64));
  assert.equal(acceptedSource.observedContentHash, 'b'.repeat(64));
  repository.setSourceVerification({ id: 'source-1', verificationState: 'verified', verification: sourceVerification('b'.repeat(64)) });
  assert.equal(repository.getSource('source-1').verificationState, 'verified');
  assert.match(repository.getSource('source-1').metadata.evidenceInvalidBefore, /^\d{4}-\d{2}-\d{2}T/);
});

test('source verification requires locator, quote, claim, and current content hash', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  repository.registerSources({ sources: [sourceRecord()] });
  assert.throws(
    () => repository.setSourceVerification({ id: 'source-1', verificationState: 'verified' }),
    /定位|引文|主张|哈希/,
  );
  assert.throws(
    () => repository.setSourceVerification({
      id: 'source-1',
      verificationState: 'verified',
      verification: {
        locator: 'line:3',
        quote: 'Supported result.',
        claim: 'The result is supported.',
        contentHash: 'b'.repeat(64),
      },
    }),
    /内容哈希/,
  );

  const state = repository.setSourceVerification({
    id: 'source-1',
    verificationState: 'verified',
    verification: {
      locator: 'line:3',
      quote: 'Supported result.',
      claim: 'The result is supported.',
      contentHash: sourceRecord().contentHash,
    },
  });
  const verified = state.sources.find((source) => source.id === 'source-1');
  assert.equal(verified.verificationState, 'verified');
  assert.equal(verified.metadata.verification.contentHash, sourceRecord().contentHash);
});

test('source repository refuses verification without resolved metadata', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  repository.registerSources({
    sources: [sourceRecord({
      title: 'DOI 10.1000/placeholder',
      authors: [],
      year: null,
      venue: '',
      doi: '10.1000/placeholder',
      stableIdentifier: 'doi:10.1000/placeholder',
    })],
  });
  assert.throws(
    () => repository.setSourceVerification({
      id: 'source-1',
      verificationState: 'verified',
      verification: sourceVerification(),
    }),
    /元数据/,
  );
});

test('source verification records accumulate independent evidence claims', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  repository.registerSources({ sources: [sourceRecord()] });
  repository.setSourceVerification({
    id: 'source-1',
    verificationState: 'verified',
    verification: sourceVerification(),
  });
  const state = repository.setSourceVerification({
    id: 'source-1',
    verificationState: 'verified',
    verification: {
      locator: 'line:5',
      quote: 'Second supported result.',
      claim: 'The second result is supported.',
      contentHash: 'a'.repeat(64),
    },
  });
  assert.equal(state.sources[0].metadata.verifications.length, 2);
});

test('checkpoints can persist a pending decision before the dialog resolves', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const pending = repository.beginCheckpoint({
    type: 'source-removal',
    rationale: 'Awaiting user decision.',
    metadata: { trigger: 'Remove source', risk: 'Evidence freeze' },
  });
  assert.equal(pending.decision, 'pending');
  assert.equal(repository.listCheckpoints()[0].id, pending.id);

  const resolved = repository.resolveCheckpoint({
    id: pending.id,
    decision: 'cancelled',
    rationale: 'User cancelled removal.',
    metadata: { sourceId: 'source-1' },
  });
  assert.equal(resolved.decision, 'cancelled');
  assert.deepEqual(resolved.metadata, { trigger: 'Remove source', risk: 'Evidence freeze', sourceId: 'source-1' });
});

test('pending source revision checkpoints survive restart and resolve atomically', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  let repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  repository.registerSources({ sources: [sourceRecord()] });
  repository.refreshSourceIntegrity({ id: 'source-1', contentHash: 'b'.repeat(64) });
  const pending = repository.beginCheckpoint({
    type: 'source-revision-accepted',
    rationale: 'Awaiting the user.',
    metadata: { sourceId: 'source-1', observedContentHash: 'b'.repeat(64) },
  });
  repository.close();

  repository = openTestRepository(databasePath);
  assert.equal(repository.listPendingCheckpoints()[0].id, pending.id);
  const state = repository.resolveSourceCheckpoint({
    id: pending.id,
    decision: 'approved',
    rationale: 'User accepted the revision.',
  });
  assert.equal(state.sources.find((source) => source.id === 'source-1').freshnessState, 'current');
  assert.equal(repository.listPendingCheckpoints().length, 0);
  assert.equal(repository.listCheckpoints().find((checkpoint) => checkpoint.id === pending.id).decision, 'approved');
});

test('failed source checkpoint mutation rolls back the checkpoint decision', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  repository.registerSources({ sources: [sourceRecord()] });
  repository.refreshSourceIntegrity({ id: 'source-1', contentHash: 'b'.repeat(64) });
  const pending = repository.beginCheckpoint({
    type: 'source-revision-accepted',
    rationale: 'Awaiting the user.',
    metadata: { sourceId: 'source-1', observedContentHash: 'c'.repeat(64) },
  });
  assert.throws(
    () => repository.resolveSourceCheckpoint({
      id: pending.id,
      decision: 'approved',
      rationale: 'User accepted the revision.',
    }),
    /内容已再次变化/,
  );
  assert.equal(repository.listPendingCheckpoints()[0].id, pending.id);
  assert.equal(repository.getSource('source-1').freshnessState, 'stale');
});

test('refreshing one record in a shared bibliography marks every dependent record stale', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  repository.registerSources({
    sources: [
      sourceRecord({ id: 'source-1', title: 'First Record', localLocator: '.science/sources/library.bib#entry-1' }),
      sourceRecord({
        id: 'source-2',
        title: 'Second Record',
        doi: '10.1000/second',
        stableIdentifier: 'doi:10.1000/second',
        localLocator: '.science/sources/library.bib#entry-2',
      }),
    ],
  });
  const state = repository.refreshSourceIntegrity({
    id: 'source-1',
    contentHash: 'b'.repeat(64),
    observedRevisionLocator: '.science/source-revisions/new.revision',
  });
  for (const source of state.sources) {
    assert.equal(source.freshnessState, 'stale');
    assert.equal(source.observedContentHash, 'b'.repeat(64));
    assert.equal(source.verificationState, 'unverified');
    assert.equal(source.metadata.observedRevisionLocator, '.science/source-revisions/new.revision');
  }
});

test('generic checkpoint resolution preserves the pending audit metadata', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const pending = repository.beginCheckpoint({
    type: 'external-source-fetch',
    rationale: 'Sensitive external retrieval.',
    metadata: {
      action: 'refresh-source',
      payload: { sourceId: 'source-1' },
      policy: 'sensitive',
      charterVersion: 2,
    },
  });
  const resolved = repository.resolveCheckpoint({
    id: pending.id,
    decision: 'approved',
    rationale: 'User approved retrieval.',
  });
  assert.equal(resolved.metadata.action, 'refresh-source');
  assert.equal(resolved.metadata.payload.sourceId, 'source-1');
  assert.equal(resolved.metadata.policy, 'sensitive');
});

test('pending source checkpoints are filtered and accept only explicit decisions', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  repository.registerSources({ sources: [sourceRecord()] });
  repository.beginCheckpoint({
    type: 'external-transmission',
    rationale: 'Unrelated durable checkpoint.',
    metadata: { trigger: 'External transmission', risk: 'Data leaves the machine' },
  });
  const pending = repository.beginCheckpoint({
    type: 'source-removal',
    rationale: 'Remove source.',
    metadata: { sourceId: 'source-1', trigger: 'Remove source', risk: 'Evidence freeze' },
  });
  assert.deepEqual(repository.listPendingCheckpoints().map((checkpoint) => checkpoint.id), [pending.id]);
  assert.throws(
    () => repository.resolveSourceCheckpoint({
      id: pending.id,
      decision: 'accepted maybe',
      rationale: 'Malformed decision.',
    }),
    /approved|declined|cancelled/i,
  );
  assert.equal(repository.listPendingCheckpoints()[0].id, pending.id);
});

test('policy and verification checkpoints remain recoverable and atomic', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  repository.registerSources({ sources: [sourceRecord()] });
  const policy = repository.beginCheckpoint({
    type: 'external-source-fetch',
    rationale: 'External retrieval requires policy confirmation.',
    metadata: {
      trigger: 'Fetch external source.',
      risk: 'Project context may leave the machine.',
      options: ['Fetch source content', 'Cancel'],
      recommendation: 'Fetch only when policy permits.',
      estimatedTimeCost: 'One network request.',
    },
  });
  const verification = repository.beginCheckpoint({
    type: 'source-verification',
    rationale: 'Awaiting verification confirmation.',
    metadata: {
      sourceId: 'source-1',
      ...sourceVerification(),
      trigger: 'Verify source evidence.',
      risk: 'Unsupported claims may be cited.',
      options: ['Verify Source', 'Leave Source unverified'],
      recommendation: 'Verify only when the quote supports the claim.',
      estimatedTimeCost: 'Local review.',
    },
  });
  assert.deepEqual(
    new Set(repository.listPendingCheckpoints().map((checkpoint) => checkpoint.id)),
    new Set([policy.id, verification.id]),
  );

  repository.resolveSourceCheckpoint({
    id: policy.id,
    decision: 'approved',
    rationale: 'User allowed the external fetch.',
  });
  const state = repository.resolveSourceCheckpoint({
    id: verification.id,
    decision: 'approved',
    rationale: 'User confirmed the evidence and claim.',
  });
  assert.equal(state.sources[0].verificationState, 'verified');
  assert.equal(state.sources[0].metadata.verifications.length, 1);
  assert.equal(repository.listPendingCheckpoints().length, 0);
});

test('approved external actions remain recoverable until execution completes', (t) => {
  const { directory, databasePath } = temporaryDatabase();
  const repository = openTestRepository(databasePath);
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const pending = repository.beginCheckpoint({
    type: 'external-source-fetch',
    rationale: 'External fetch.',
    metadata: {
      action: 'refresh-source',
      payload: { sourceId: 'source-1' },
      trigger: 'Fetch source.',
      risk: 'Data leaves the machine.',
      options: ['Fetch', 'Cancel'],
      recommendation: 'Fetch when allowed.',
      estimatedTimeCost: 'One request.',
    },
  });
  repository.resolveCheckpoint({
    id: pending.id,
    decision: 'approved',
    rationale: 'User approved.',
    metadata: { executionState: 'pending-execution' },
  });
  assert.equal(repository.listPendingCheckpoints()[0].id, pending.id);
  repository.resolveCheckpoint({
    id: pending.id,
    decision: 'approved',
    rationale: 'Action completed.',
    metadata: { executionState: 'completed' },
  });
  assert.equal(repository.listPendingCheckpoints().length, 0);
});
