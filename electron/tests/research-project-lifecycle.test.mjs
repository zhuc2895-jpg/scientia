import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createConfigStore } from '../config-store.js';
import { openProductRepository } from '../product-repository.js';
import { createResearchProjectLifecycle } from '../research-project-lifecycle.js';

function temporaryRepository(t, { workspacePath = 'C:/Research/Alpha' } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'scientia-research-project-lifecycle-'));
  const repository = openProductRepository({ databasePath: path.join(directory, 'product.sqlite3') });
  if (workspacePath) repository.bindPendingBootstrapResearchProject({ workspacePath });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return repository;
}

function temporaryConfigPath(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'scientia-research-project-lifecycle-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'science-agent.json');
}

async function prepareResearchWorkspace(workspacePath) {
  return workspacePath;
}

function createBetaResearchProject(repository) {
  return repository.createProject({
    id: 'research-project-beta',
    name: 'Beta',
    workspacePath: 'C:/Research/Beta',
    workspaceKind: 'managed',
  });
}

function fakeConfigStore({ read = async () => ({}), write = async () => {} } = {}) {
  const store = {
    update: async (mutator) => {
      const current = await read();
      const value = await mutator(current);
      if (value !== current) await write(value);
      return value;
    },
  };
  store.updateOrReset = store.update;
  return store;
}

function createLifecycle(repository, options = {}) {
  return createResearchProjectLifecycle({
    productRepository: repository,
    validateResearchWorkspace: async () => {},
    ...options,
  });
}

test('Research Project activation remains consistent when config synchronization fails', async (t) => {
  const repository = temporaryRepository(t);
  const alpha = repository.loadState().project;
  const beta = createBetaResearchProject(repository);
  const configSyncErrors = [];
  const lifecycle = createLifecycle(repository, {
    configStore: fakeConfigStore({
      read: async () => ({ workspace: beta.workspacePath }),
      write: async () => { throw new Error('disk full'); },
    }),
    onConfigSyncError: (error) => configSyncErrors.push(error.message),
  });

  const state = await lifecycle.activateResearchProject(alpha.id);

  assert.equal(state.activeProjectId, alpha.id);
  assert.equal(state.project.workspacePath, alpha.workspacePath);
  assert.equal(repository.loadState().activeProjectId, alpha.id);
  assert.deepEqual(configSyncErrors, ['disk full']);
});

test('Research Project archival remains consistent when config synchronization fails', async (t) => {
  const repository = temporaryRepository(t);
  const alpha = repository.loadState().project;
  const beta = createBetaResearchProject(repository);
  const lifecycle = createLifecycle(repository, {
    configStore: fakeConfigStore({
      read: async () => ({ workspace: beta.workspacePath }),
      write: async () => { throw new Error('config unavailable'); },
    }),
  });

  const state = await lifecycle.archiveResearchProject(beta.id);

  assert.equal(state.activeProjectId, alpha.id);
  assert.equal(state.projects.find((project) => project.id === beta.id).archivedAt === null, false);
  assert.equal(repository.loadState().activeProjectId, alpha.id);
});

test('Research Project restoration remains consistent when config synchronization fails', async (t) => {
  const repository = temporaryRepository(t);
  const alpha = repository.loadState().project;
  const beta = createBetaResearchProject(repository);
  repository.archiveProject(beta.id);
  const lifecycle = createLifecycle(repository, {
    configStore: fakeConfigStore({
      read: async () => { throw new Error('config unreadable'); },
      write: async () => {},
    }),
  });

  const state = await lifecycle.restoreResearchProject(beta.id);

  assert.equal(state.activeProjectId, alpha.id);
  assert.equal(state.projects.find((project) => project.id === beta.id).archivedAt, null);
  assert.equal(repository.loadState().projects.find((project) => project.id === beta.id).archivedAt, null);
});

test('Research Project deletion remains consistent when config synchronization fails', async (t) => {
  const repository = temporaryRepository(t);
  const alpha = repository.loadState().project;
  const beta = createBetaResearchProject(repository);
  const lifecycle = createLifecycle(repository, {
    configStore: fakeConfigStore({
      read: async () => ({ workspace: beta.workspacePath }),
      write: async () => { throw new Error('config write failed'); },
    }),
  });
  let cleanupProjectId = null;

  const state = await lifecycle.deleteResearchProject({
    id: beta.id,
    confirmationName: beta.name,
    cleanupManagedResearchWorkspace: async (project) => { cleanupProjectId = project.id; },
  });

  assert.equal(state.deletedProject.id, beta.id);
  assert.equal(state.activeProjectId, alpha.id);
  assert.equal(repository.loadState().projects.some((project) => project.id === beta.id), false);
  assert.equal(cleanupProjectId, beta.id);
});

test('Research Workspace cleanup failure without a message reports a localized warning', async (t) => {
  const repository = temporaryRepository(t);
  const beta = createBetaResearchProject(repository);
  const lifecycle = createLifecycle(repository, {
    configStore: fakeConfigStore({
      read: async () => ({ workspace: beta.workspacePath }),
      write: async () => {},
    }),
  });

  const state = await lifecycle.deleteResearchProject({
    id: beta.id,
    confirmationName: beta.name,
    cleanupManagedResearchWorkspace: async () => { throw new Error(''); },
  });

  assert.equal(state.researchWorkspaceCleanupWarning, '受管理 Research Workspace 未能删除。');
});

test('Research Project creation remains consistent when config synchronization fails', async (t) => {
  const repository = temporaryRepository(t);
  const alpha = repository.loadState().project;
  const lifecycle = createLifecycle(repository, {
    configStore: fakeConfigStore({
      read: async () => ({ workspace: alpha.workspacePath }),
      write: async () => { throw new Error('config write failed'); },
    }),
  });

  const state = await lifecycle.createResearchProject({
    id: 'research-project-beta',
    name: 'Beta',
    workspacePath: 'C:/Research/Beta',
    workspaceKind: 'managed',
  });

  assert.equal(state.activeProjectId, 'research-project-beta');
  assert.equal(state.project.workspacePath, 'C:/Research/Beta');
  assert.equal(repository.loadState().activeProjectId, 'research-project-beta');
});

test('deleting the last Research Project leaves no active Research Workspace', async (t) => {
  const repository = temporaryRepository(t);
  const alpha = repository.loadState().project;
  const lifecycle = createLifecycle(repository, {
    configStore: fakeConfigStore({
      read: async () => ({ workspace: alpha.workspacePath }),
      write: async () => { throw new Error('config write failed'); },
    }),
    onConfigSyncError: () => {},
  });

  const state = await lifecycle.deleteResearchProject({
    id: alpha.id,
    confirmationName: alpha.name,
    cleanupManagedResearchWorkspace: async () => {},
  });

  assert.equal(state.activeProjectId, null);
  assert.equal(repository.getActiveResearchWorkspacePath(), '');
  assert.equal(Object.hasOwn(state, 'configSyncWarning'), false);
});

test('application startup remains available when derived config synchronization fails', async (t) => {
  const repository = temporaryRepository(t);
  const alpha = repository.loadState().project;
  const configErrors = [];
  const lifecycle = createLifecycle(repository, {
    configStore: fakeConfigStore({
      read: async () => ({ workspace: 'C:/Research/Stale' }),
      write: async () => { throw new Error('config write failed'); },
    }),
    onConfigSyncError: (error) => configErrors.push(error.message),
  });
  let ensuredWorkspace = null;

  const state = await lifecycle.initializeResearchProjectState({
    configuredResearchWorkspace: 'C:/Research/Stale',
    ensureResearchWorkspace: async (workspace) => { ensuredWorkspace = workspace; return workspace; },
  });

  assert.equal(state.activeProjectId, alpha.id);
  assert.equal(ensuredWorkspace, alpha.workspacePath);
  assert.deepEqual(configErrors, ['config write failed']);
});

test('startup does not expose a Research Project without a Research Workspace', async (t) => {
  const repository = temporaryRepository(t, { workspacePath: null });
  let ensuredWorkspace = null;
  const lifecycle = createLifecycle(repository, {
    configStore: fakeConfigStore(),
  });

  const state = await lifecycle.initializeResearchProjectState({
    configuredResearchWorkspace: '',
    ensureResearchWorkspace: async (workspace) => { ensuredWorkspace = workspace; return workspace; },
  });

  assert.equal(ensuredWorkspace, null);
  assert.equal(state.activeProjectId, null);
  assert.equal(state.project, null);
  assert.deepEqual(state.projects, []);
  assert.equal(state.requiresResearchWorkspaceBinding, true);
});

test('a throwing config error observer does not break lifecycle consistency', async (t) => {
  const repository = temporaryRepository(t);
  const beta = createBetaResearchProject(repository);
  const lifecycle = createLifecycle(repository, {
    configStore: fakeConfigStore({
      read: async () => ({ workspace: 'C:/Research/Stale' }),
      write: async () => { throw new Error('config write failed'); },
    }),
    onConfigSyncError: () => { throw new Error('observer crashed'); },
  });

  const state = await lifecycle.activateResearchProject(beta.id);

  assert.equal(state.activeProjectId, beta.id);
  assert.equal(repository.loadState().activeProjectId, beta.id);
});

test('a rejecting config error observer does not break lifecycle consistency', async (t) => {
  const repository = temporaryRepository(t);
  const beta = createBetaResearchProject(repository);
  const unhandledRejections = [];
  const onUnhandledRejection = (reason) => unhandledRejections.push(reason?.message || String(reason));
  process.on('unhandledRejection', onUnhandledRejection);
  t.after(() => process.off('unhandledRejection', onUnhandledRejection));
  const lifecycle = createLifecycle(repository, {
    configStore: fakeConfigStore({
      read: async () => ({ workspace: 'C:/Research/Stale' }),
      write: async () => { throw new Error('config write failed'); },
    }),
    onConfigSyncError: async () => { throw new Error('observer failed'); },
  });

  const state = await lifecycle.activateResearchProject(beta.id);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(state.activeProjectId, beta.id);
  assert.equal(repository.loadState().activeProjectId, beta.id);
  assert.deepEqual(unhandledRejections, []);
});

test('Research Project mutation returns canonical state after overlapping activation', async (t) => {
  const repository = temporaryRepository(t);
  const alpha = repository.loadState().project;
  let releaseFirstSync;
  let firstSyncStarted;
  const firstSync = new Promise((resolve) => { firstSyncStarted = resolve; });
  const firstSyncGate = new Promise((resolve) => { releaseFirstSync = resolve; });
  let queue = Promise.resolve();
  let updateCount = 0;
  const configStore = {
    update(mutator) {
      const operation = queue.then(async () => {
        updateCount += 1;
        if (updateCount === 1) {
          firstSyncStarted();
          await firstSyncGate;
        }
        return mutator({ workspace: alpha.workspacePath });
      });
      queue = operation.catch(() => {});
      return operation;
    },
  };
  configStore.updateOrReset = configStore.update;
  const lifecycle = createLifecycle(repository, {
    configStore,
  });

  const creating = lifecycle.createResearchProject({
    id: 'research-project-beta',
    name: 'Beta',
    workspacePath: 'C:/Research/Beta',
    workspaceKind: 'managed',
  });
  await firstSync;
  const activating = lifecycle.activateResearchProject(alpha.id);
  releaseFirstSync();
  const [createdState, activatedState] = await Promise.all([creating, activating]);

  assert.equal(createdState.activeProjectId, alpha.id);
  assert.equal(createdState.project.workspacePath, alpha.workspacePath);
  assert.equal(activatedState.activeProjectId, alpha.id);
  assert.equal(repository.loadState().activeProjectId, alpha.id);
});

test('Research Project creation validates its Research Workspace before persisting', async (t) => {
  const repository = temporaryRepository(t);
  let validatedWorkspace = '';
  const lifecycle = createLifecycle(repository, {
    configStore: fakeConfigStore(),
    validateResearchWorkspace: async (workspacePath) => {
      validatedWorkspace = workspacePath;
      throw new Error('invalid Research Workspace');
    },
  });

  await assert.rejects(lifecycle.createResearchProject({
    id: 'research-project-beta',
    name: 'Beta',
    workspacePath: 'C:/Research/Beta',
    workspaceKind: 'managed',
  }), /invalid Research Workspace/);

  assert.equal(validatedWorkspace, 'C:/Research/Beta');
  assert.equal(repository.loadState().projects.some((project) => project.id === 'research-project-beta'), false);
});

test('Research Project lifecycle requires Research Workspace validation', () => {
  assert.throws(() => createResearchProjectLifecycle({
    productRepository: {},
    configStore: fakeConfigStore(),
  }), /Research Workspace validation/);
});

test('deleting an imported Research Project does not clean its Research Workspace', async (t) => {
  const repository = temporaryRepository(t);
  const importedProject = repository.loadState().project;
  let cleanupCalls = 0;
  const lifecycle = createLifecycle(repository, {
    configStore: fakeConfigStore(),
  });

  await lifecycle.deleteResearchProject({
    id: importedProject.id,
    confirmationName: importedProject.name,
    cleanupManagedResearchWorkspace: async () => { cleanupCalls += 1; },
  });

  assert.equal(cleanupCalls, 0);
  assert.equal(repository.loadState().projects.length, 0);
});

test('configuration save rejects a Research Workspace that became stale while preparing', async (t) => {
  const repository = temporaryRepository(t);
  const alpha = repository.loadState().project;
  const beta = createBetaResearchProject(repository);
  let releaseWorkspacePreparation;
  let workspacePreparationStarted;
  const preparationStarted = new Promise((resolve) => { workspacePreparationStarted = resolve; });
  const preparationGate = new Promise((resolve) => { releaseWorkspacePreparation = resolve; });
  let writtenConfig = null;
  const lifecycle = createLifecycle(repository, {
    configStore: fakeConfigStore({
      write: async (config) => { writtenConfig = config; },
    }),
  });

  const saving = lifecycle.saveConfiguration({
    requestedResearchWorkspace: beta.workspacePath,
    configurationValues: { model: 'updated-model' },
    ensureResearchWorkspace: async () => {
      workspacePreparationStarted();
      await preparationGate;
      return beta.workspacePath;
    },
  });
  await preparationStarted;
  repository.setActiveProject(alpha.id);
  releaseWorkspacePreparation();

  await assert.rejects(saving, /Research Workspace.*绑定/);
  assert.equal(writtenConfig, null);
});

test('configuration save persists settings for the active Research Project', async (t) => {
  const repository = temporaryRepository(t);
  const alpha = repository.loadState().project;
  let writtenConfig = null;
  const lifecycle = createLifecycle(repository, {
    configStore: fakeConfigStore({
      read: async () => ({ model: 'old-model', apiKeyEncrypted: 'sealed' }),
      write: async (config) => { writtenConfig = config; },
    }),
  });

  const result = await lifecycle.saveConfiguration({
    requestedResearchWorkspace: alpha.workspacePath,
    configurationValues: { model: 'new-model' },
    ensureResearchWorkspace: async () => alpha.workspacePath,
  });

  assert.deepEqual(result.configuration, {
    model: 'new-model',
    apiKeyEncrypted: 'sealed',
    workspace: alpha.workspacePath,
  });
  assert.deepEqual(writtenConfig, result.configuration);
});

test('configuration save binds the bootstrap Research Project to its first Research Workspace', async (t) => {
  const repository = temporaryRepository(t, { workspacePath: null });
  let writtenConfig = null;
  const lifecycle = createLifecycle(repository, {
    configStore: fakeConfigStore({
      write: async (config) => { writtenConfig = config; },
    }),
  });

  const researchWorkspace = path.resolve('C:/Research/First');
  const result = await lifecycle.saveConfiguration({
    requestedResearchWorkspace: 'C:/Research/First',
    configurationValues: { model: 'new-model' },
    ensureResearchWorkspace: prepareResearchWorkspace,
  });

  const state = repository.loadState();
  assert.equal(result.configuration.workspace, researchWorkspace);
  assert.deepEqual(writtenConfig, result.configuration);
  assert.equal(state.project.workspacePath, researchWorkspace);
  assert.equal(state.project.workspaceKind, 'imported');
  assert.equal(state.requiresResearchWorkspaceBinding, false);
});

test('configuration save reports an invalid Research Workspace path', async (t) => {
  const repository = temporaryRepository(t);
  const lifecycle = createLifecycle(repository, { configStore: fakeConfigStore() });

  await assert.rejects(lifecycle.saveConfiguration({
    requestedResearchWorkspace: 'relative-research-workspace',
    configurationValues: { model: 'updated-model' },
    ensureResearchWorkspace: async (pathValue) => pathValue,
  }), /请选择一个 Research Workspace/);
});

test('configuration save repairs malformed config while binding the pending bootstrap record', async (t) => {
  const repository = temporaryRepository(t, { workspacePath: null });
  const configPath = temporaryConfigPath(t);
  writeFileSync(configPath, '{ broken json', 'utf8');
  const configStore = createConfigStore({ filePath: configPath, defaults: () => ({ model: 'default-model' }) });
  const lifecycle = createLifecycle(repository, { configStore });
  const researchWorkspace = path.resolve('C:/Research/Recovered');

  const result = await lifecycle.saveConfiguration({
    requestedResearchWorkspace: 'C:/Research/Recovered',
    configurationValues: { workspace: researchWorkspace },
    ensureResearchWorkspace: prepareResearchWorkspace,
  });

  assert.equal(result.configuration.workspace, researchWorkspace);
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), {
    model: 'default-model',
    workspace: researchWorkspace,
  });
  assert.equal(repository.loadState().project.workspacePath, researchWorkspace);
});

test('a pending bootstrap Research Project blocks creating another Research Project', async (t) => {
  const repository = temporaryRepository(t, { workspacePath: null });
  const lifecycle = createLifecycle(repository, { configStore: fakeConfigStore() });

  await assert.rejects(lifecycle.createResearchProject({
    id: 'research-project-orphan',
    name: 'Orphan Candidate',
    workspacePath: 'C:/Research/Orphan',
    workspaceKind: 'managed',
  }), /待绑定|pending/i);

  const state = repository.loadState();
  assert.equal(state.requiresResearchWorkspaceBinding, true);
  assert.deepEqual(state.projects, []);
});

test('configuration save returns committed Product state when derived config persistence fails', async (t) => {
  const repository = temporaryRepository(t, { workspacePath: null });
  const researchWorkspace = path.resolve('C:/Research/Committed');
  const lifecycle = createLifecycle(repository, {
    configStore: fakeConfigStore({
      write: async () => { throw new Error('config disk full'); },
    }),
  });

  const result = await lifecycle.saveConfiguration({
    requestedResearchWorkspace: researchWorkspace,
    configurationValues: { model: 'updated-model' },
    ensureResearchWorkspace: prepareResearchWorkspace,
  });

  assert.equal(result.productState.project.workspacePath, researchWorkspace);
  assert.equal(result.configuration, null);
  assert.match(result.configError.message, /config disk full/);
});

test('deleting a managed Research Project requires Research Workspace cleanup', async (t) => {
  const repository = temporaryRepository(t);
  const beta = createBetaResearchProject(repository);
  const lifecycle = createLifecycle(repository, { configStore: fakeConfigStore() });

  await assert.rejects(lifecycle.deleteResearchProject({
    id: beta.id,
    confirmationName: beta.name,
  }), /cleanup|清理/i);

  assert.equal(repository.getProject(beta.id)?.id, beta.id);
});

test('the pending bootstrap record cannot be archived or restored as a Research Project', async (t) => {
  const repository = temporaryRepository(t, { workspacePath: null });
  const lifecycle = createLifecycle(repository, { configStore: fakeConfigStore() });

  assert.throws(
    () => lifecycle.archiveResearchProject('scientia-default-project'),
    /不存在的 Research Project/,
  );
  assert.throws(
    () => lifecycle.restoreResearchProject('scientia-default-project'),
    /不存在的 Research Project/,
  );
  assert.equal(repository.loadState().requiresResearchWorkspaceBinding, true);
});
