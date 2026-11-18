import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(
  root,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron',
);
const userData = mkdtempSync(path.join(os.tmpdir(), 'scientia-product-smoke-'));
let port = 0;
let child = null;
let socket = null;
let cdp = null;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function pollUntil(probe, predicate = Boolean) {
  let value;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    value = await probe();
    if (predicate(value)) return value;
    await delay(100);
  }
  return value;
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function launchApp() {
  port = await availablePort();
  child = spawn(electron, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userData}`,
    root,
  ], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (process.env.SCIENTIA_SMOKE_DEBUG) process.stderr.write(`[electron stdout] ${chunk}`);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (process.env.SCIENTIA_SMOKE_DEBUG) process.stderr.write(`[electron stderr] ${chunk}`);
  });
  child.once('exit', (code) => {
    if (process.env.SCIENTIA_SMOKE_DEBUG) console.error('electron exited', code, stderr);
    if (code && code !== 0) process.stderr.write(stderr);
  });

  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const page = pages.find((target) => target.type === 'page' && target.url.includes('/app/index.html'));
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Electron may still be starting.
    }
    await delay(100);
  }
  throw new Error(`Electron renderer did not start.${stderr ? `\n${stderr}` : ''}`);
}

async function connect(webSocketDebuggerUrl) {
  socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject, timeout } = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(timeout);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const { reject, timeout } of pending.values()) {
      clearTimeout(timeout);
      reject(new Error('Electron debugging connection closed.'));
    }
    pending.clear();
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId;
    nextId += 1;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Electron debugging command timed out: ${method}`));
    }, 5000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed.');
  }
  return result.result.value;
}

async function waitForRenderer(cdp) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await evaluate(cdp, 'document.readyState === "complete" && Boolean(window.scienceAgent)')) return;
    await delay(100);
  }
  throw new Error('Renderer application did not become ready.');
}

async function waitForActiveResearchProject(cdp, { id = null, name }) {
  const state = await pollUntil(
    () => evaluate(cdp, 'window.scienceAgent.productStateLoad()'),
    (value) => value.project?.name === name && (!id || value.activeProjectId === id),
  );
  assert.equal(state.project.name, name);
  if (id) assert.equal(state.activeProjectId, id);
  const label = await pollUntil(
    () => evaluate(cdp, `document.querySelector('.project-item.active .project-item-name')?.textContent || ''`),
    (value) => value === name,
  );
  assert.equal(label, name);
  return state;
}

async function waitForActiveConversation(cdp, conversationId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const active = await evaluate(cdp, `Boolean(document.querySelector('[data-conversation-id="${conversationId}"].active'))`);
    if (active) return;
    await delay(100);
  }
  throw new Error(`Conversation ${conversationId} did not become active in the renderer.`);
}

async function waitForResearchStage(cdp, currentStageKey) {
  const state = await pollUntil(
    () => evaluate(cdp, 'window.scienceAgent.productStateLoad()'),
    (value) => value.project?.stageGraph?.currentStageKey === currentStageKey,
  );
  assert.equal(state.project.stageGraph.currentStageKey, currentStageKey);
  const renderedStage = await pollUntil(
    () => evaluate(cdp, `document.querySelector('#project-home')?.dataset.currentStageKey || ''`),
    (value) => value === currentStageKey,
  );
  assert.equal(renderedStage, currentStageKey);
  return state;
}

async function findProductDatabaseFiles(directory) {
  const matches = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) matches.push(...await findProductDatabaseFiles(absolute));
    else if (entry.name.startsWith('scientia-product.sqlite3')) matches.push(absolute);
  }
  return matches;
}

async function findFile(directory, filename) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const match = await findFile(absolute, filename);
      if (match) return match;
    } else if (entry.name === filename) return absolute;
  }
  return null;
}

async function stopApp({ graceful = true } = {}) {
  if (graceful && socket && child && child.exitCode === null) {
    try {
      await cdp('Runtime.evaluate', {
        expression: 'window.scienceAgent.quitApp()',
        awaitPromise: true,
        returnByValue: true,
      });
    } catch {
      // Closing the renderer destroys the debugging context before the reply arrives.
    }
  }
  if (socket) socket.close();
  socket = null;
  cdp = null;
  if (!child || child.exitCode !== null) return;
  if (graceful) {
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      delay(1500),
    ]);
    if (!child || child.exitCode !== null) return;
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGKILL');
  }
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(5000),
  ]);
  await delay(500);
}

try {
  cdp = await connect(await launchApp());
  await waitForRenderer(cdp);
  assert.equal(await evaluate(cdp, `!document.querySelector('#api-key') && Boolean(document.querySelector('#set-api-key'))`), true);
  console.log('OK   API key input never enters the renderer');
  await evaluate(cdp, 'window.scienceAgent.windowControl("close")');
  await delay(300);
  assert.equal(await evaluate(cdp, 'document.hidden'), true);
  assert.equal(child.exitCode, null);
  console.log('OK   Closing the window hides it without stopping the application');
  await stopApp();

  cdp = await connect(await launchApp());
  await waitForRenderer(cdp);
  await evaluate(cdp, `(() => {
    document.querySelector('#add-project').click();
    document.querySelector('#project-name').value = 'Smoke Project';
    document.querySelector('#create-project').click();
    return true;
  })()`);
  let smokeProjectState = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    smokeProjectState = await evaluate(cdp, 'window.scienceAgent.productStateLoad()');
    if (smokeProjectState.project?.name === 'Smoke Project') break;
    await delay(100);
  }
  assert.equal(smokeProjectState.project.name, 'Smoke Project');
  const workspace = smokeProjectState.project.workspacePath;
  const immutableBinding = await evaluate(cdp, `(async () => {
    const config = await window.scienceAgent.configLoad();
    return window.scienceAgent.configSave({ ...config, workspace: 'C:\\\\Research\\\\Other Project' })
      .then(() => ({ ok: true, message: '' }), (error) => ({ ok: false, message: error.message }));
  })()`);
  assert.equal(immutableBinding.ok, false);
  assert.match(immutableBinding.message, /不可更换/);
  await evaluate(cdp, `document.querySelector('#new-research').click()`);
  await delay(250);
  const created = await evaluate(cdp, 'window.scienceAgent.productStateLoad()');
  assert.equal(created.conversations.length, 1);
  assert.equal(created.activeId, created.conversations[0].id);
  const expectedId = created.activeId;
  let stageState = await waitForResearchStage(cdp, 'scoping');
  assert.equal(await evaluate(cdp, `document.querySelectorAll('.project-stage-card').length`), 6);
  assert.equal(await evaluate(cdp, `document.querySelector('[data-stage-card="evidence"]')?.classList.contains('pending')`), true);
  assert.match(await evaluate(cdp, `document.querySelector('[data-stage-card="evidence"]')?.title || ''`), /Scoping/);
  await evaluate(cdp, `document.querySelector('[data-stage-action="complete"]').click()`);
  stageState = await waitForResearchStage(cdp, 'evidence');
  assert.equal(stageState.project.stageGraph.stages.find((stage) => stage.key === 'scoping').status, 'completed');
  assert.match(await evaluate(cdp, `document.querySelector('[data-stage-card="synthesis"]')?.title || ''`), /Evidence/);
  await evaluate(cdp, `(() => {
    document.querySelector('[data-stage-action="not-applicable"]').click();
    document.querySelector('#stage-na-reason').value = 'The project uses only locally generated simulation output.';
    document.querySelector('#stage-na-form').requestSubmit();
    return true;
  })()`);
  stageState = await waitForResearchStage(cdp, 'inquiry');
  const evidenceStage = stageState.project.stageGraph.stages.find((stage) => stage.key === 'evidence');
  assert.equal(evidenceStage.status, 'not_applicable');
  assert.equal(evidenceStage.notApplicableReason, 'The project uses only locally generated simulation output.');
  console.log('OK   Research Stage graph exposes locks and persists completed and not-applicable stages');

  const workspaceGuard = await evaluate(cdp, `(async () => {
    const config = await window.scienceAgent.configLoad();
    const rebound = await window.scienceAgent.configSave({ ...config, workspace: 'C:\\\\Research\\\\Other Project' })
      .then(() => ({ ok: true, message: '' }), (error) => ({ ok: false, message: error.message }));
    return { initialWorkspace: config.workspace, project: (await window.scienceAgent.productStateLoad()).project, rebound };
  })()`);
  assert.equal(workspaceGuard.project.workspacePath, workspaceGuard.initialWorkspace);
  assert.equal(workspaceGuard.rebound.ok, false);
  assert.match(workspaceGuard.rebound.message, /不可更换/);
  console.log('OK   Research Workspace binding is immutable');
  const inspectedWorkspace = await evaluate(cdp, `window.scienceAgent.inspectWorkspace('C:\\\\Windows')`);
  assert.equal(inspectedWorkspace.workspace, workspace);
  console.log('OK   Filesystem access ignores renderer-supplied workspace roots');
  const importGuard = await evaluate(cdp, `(async () => ({
    hasRawPathApi: typeof window.scienceAgent.getPathForFile === 'function',
    forged: await window.scienceAgent.importFiles(['forged-token'])
      .then(() => ({ ok: true, message: '' }), (error) => ({ ok: false, message: error.message })),
  }))()`);
  assert.equal(importGuard.hasRawPathApi, false);
  assert.equal(importGuard.forged.ok, false);
  assert.match(importGuard.forged.message, /导入授权无效或已过期/);
  console.log('OK   File imports require main-process authorization tokens');

  const initialProjectId = created.activeProjectId;
  const existingProjectIds = created.projects.map((project) => project.id);
  const existingProjectCount = created.projects.length;
  await evaluate(cdp, `document.querySelector('#add-project').click()`);
  assert.equal(await evaluate(cdp, `document.querySelector('#project-dialog').open`), true);
  assert.equal(await evaluate(cdp, `Boolean(document.querySelector('#project-list').compareDocumentPosition(document.querySelector('#conversation-list')) & Node.DOCUMENT_POSITION_FOLLOWING)`), true);
  await evaluate(cdp, `(() => {
    document.querySelector('#project-name').value = 'Managed Project Smoke';
    document.querySelector('#create-project').click();
    return true;
  })()`);
  const managedState = await pollUntil(
    () => evaluate(cdp, 'window.scienceAgent.productStateLoad()'),
    (state) => state.activeProjectId !== initialProjectId && state.projects.length === existingProjectCount + 1,
  );
  const managedProject = managedState.projects.find((project) => !existingProjectIds.includes(project.id));
  assert.ok(managedProject, 'managed project was not created');
  assert.equal(managedState.activeProjectId, managedProject.id);
  assert.equal(managedProject.workspaceKind, 'managed');
  assert.equal(managedProject.workspacePath.startsWith(path.join(userData, 'managed-workspaces')), true);
  assert.equal(managedProject.stageGraph.currentStageKey, 'scoping');
  assert.equal(managedState.conversations.length, 0);
  const activeProjectLabel = await pollUntil(
    () => evaluate(cdp, `document.querySelector('.project-item.active .project-item-name')?.textContent || ''`),
    (label) => label === 'Managed Project Smoke',
  );
  assert.equal(activeProjectLabel, 'Managed Project Smoke');
  console.log('OK   A managed Research Project creates its own Research Workspace and becomes the navigation root');

  await evaluate(cdp, `document.querySelector('#new-research').click()`);
  await delay(250);
  const managedConversationState = await evaluate(cdp, 'window.scienceAgent.productStateLoad()');
  assert.equal(managedConversationState.conversations.length, 1);
  assert.equal(managedConversationState.activeProjectId, managedProject.id);
  const managedInspection = await evaluate(cdp, 'window.scienceAgent.inspectWorkspace()');
  assert.equal(managedInspection.workspace, managedProject.workspacePath);
  const crossProjectRun = await evaluate(cdp, `window.scienceAgent.runAgent({
    runId: 'cross-project-run',
    conversationId: ${JSON.stringify(expectedId)},
    prompt: 'This must not run in another project.',
  }).then(() => ({ ok: true, message: '' }), (error) => ({ ok: false, message: error.message }))`);
  assert.equal(crossProjectRun.ok, false);
  assert.match(crossProjectRun.message, /当前 Research Project/);
  console.log('OK   A Research Project cannot inspect or run another Research Workspace');

  await evaluate(cdp, `document.querySelector('[data-project-id="${initialProjectId}"]').click()`);
  let switchedState = await pollUntil(
    () => evaluate(cdp, 'window.scienceAgent.productStateLoad()'),
    (state) => state.activeProjectId === initialProjectId,
  );
  assert.equal(switchedState.activeProjectId, initialProjectId);
  assert.equal(switchedState.activeId, expectedId);
  assert.equal(switchedState.conversations.length, 1);
  assert.equal(switchedState.project.stageGraph.currentStageKey, 'inquiry');
  const activeWorkspace = await pollUntil(
    async () => (await evaluate(cdp, 'window.scienceAgent.configLoad()')).workspace,
    (value) => value === workspace,
  );
  assert.equal(activeWorkspace, workspace);
  console.log('OK   Switching Research Projects changes the active Research Workspace and Conversation scope');

  await evaluate(cdp, `window.confirm = () => true; document.querySelector('[data-archive-project="${managedProject.id}"]').click()`);
  const archivedState = await pollUntil(
    () => evaluate(cdp, 'window.scienceAgent.productStateLoad()'),
    (state) => state.projects.some((project) => project.id === managedProject.id && project.archivedAt),
  );
  assert.equal(archivedState.projects.find((project) => project.id === managedProject.id).archivedAt !== null, true);
  const restoreControlReady = await pollUntil(
    () => evaluate(cdp, `Boolean(document.querySelector('[data-restore-project="${managedProject.id}"]'))`),
  );
  assert.equal(restoreControlReady, true);
  assert.equal((await evaluate(cdp, 'window.scienceAgent.productStateLoad()')).conversations.length, 1);
  console.log('OK   Research Project Archival is reversible and preserves Research Project data');

  await evaluate(cdp, `document.querySelector('[data-restore-project="${managedProject.id}"]').click()`);
  switchedState = await pollUntil(
    () => evaluate(cdp, 'window.scienceAgent.productStateLoad()'),
    (state) => state.projects.find((project) => project.id === managedProject.id)?.archivedAt === null,
  );
  assert.equal(switchedState.activeProjectId, initialProjectId);
  assert.equal(switchedState.projects.find((project) => project.id === managedProject.id).archivedAt, null);
  const restoredProjectControlReady = await pollUntil(
    () => evaluate(cdp, `Boolean(document.querySelector('[data-project-id="${managedProject.id}"]'))`),
  );
  assert.equal(restoredProjectControlReady, true);

  await evaluate(cdp, `document.querySelector('[data-project-id="${managedProject.id}"]').click()`);
  switchedState = await pollUntil(
    () => evaluate(cdp, 'window.scienceAgent.productStateLoad()'),
    (state) => state.activeProjectId === managedProject.id,
  );
  assert.equal(switchedState.activeProjectId, managedProject.id);
  assert.equal(switchedState.conversations.length, 1);

  await evaluate(cdp, `window.prompt = () => 'wrong name'; document.querySelector('[data-delete-project="${managedProject.id}"]').click()`);
  await delay(250);
  assert.equal((await evaluate(cdp, 'window.scienceAgent.productStateLoad()')).projects.some((project) => project.id === managedProject.id), true);
  await evaluate(cdp, `window.prompt = () => 'Managed Project Smoke'; document.querySelector('[data-delete-project="${managedProject.id}"]').click()`);
  const deletedState = await pollUntil(
    () => evaluate(cdp, 'window.scienceAgent.productStateLoad()'),
    (state) => !state.projects.some((project) => project.id === managedProject.id),
  );
  assert.equal(deletedState.projects.some((project) => project.id === managedProject.id), false);
  assert.equal(deletedState.activeProjectId, initialProjectId);
  const researchWorkspaceStillExists = await pollUntil(
    () => existsSync(managedProject.workspacePath),
    (exists) => !exists,
  );
  assert.equal(researchWorkspaceStillExists, false);
  console.log('OK   Research Project deletion requires the exact name and removes its managed Research Workspace');

  await evaluate(cdp, `document.querySelector('#new-research').click()`);
  await delay(250);
  const withSecondConversation = await evaluate(cdp, 'window.scienceAgent.productStateLoad()');
  assert.equal(withSecondConversation.project.stageGraph.currentStageKey, 'inquiry');
  await evaluate(cdp, `document.querySelector('[data-conversation-id="${expectedId}"]').click()`);
  await waitForActiveConversation(cdp, expectedId);
  assert.equal(await evaluate(cdp, `document.querySelector('#project-home').dataset.currentStageKey`), 'inquiry');
  console.log('OK   Research Stage state remains visible while switching Conversations in one Project');
  const firstConversation = withSecondConversation.conversations.find((conversation) => conversation.id === expectedId);
  const updatedConversation = {
    ...firstConversation,
    title: 'Durable evidence review',
    messages: [{ id: 'saved-message', role: 'user', content: 'Persist this exact message.', createdAt: '2026-11-17T00:15:00.000Z' }],
    updatedAt: '2026-11-17T00:15:00.000Z',
  };
  await evaluate(cdp, `window.scienceAgent.conversationUpdate(${JSON.stringify(updatedConversation)})`);
  await evaluate(cdp, `window.scienceAgent.conversationSetActive(${JSON.stringify(expectedId)})`);
  await delay(250);
  await stopApp({ graceful: false });

  cdp = await connect(await launchApp());
  await waitForRenderer(cdp);
  await waitForActiveConversation(cdp, expectedId);
  const restored = await evaluate(cdp, 'window.scienceAgent.productStateLoad()');
  assert.equal(restored.conversations.length, 2);
  assert.equal(restored.activeId, expectedId);
  assert.equal(restored.conversations.find((conversation) => conversation.id === expectedId).title, 'Durable evidence review');
  assert.equal(restored.conversations.find((conversation) => conversation.id === expectedId).messages[0].content, 'Persist this exact message.');
  assert.equal(restored.project.stageGraph.currentStageKey, 'inquiry');
  assert.equal(restored.project.stageGraph.stages.find((stage) => stage.key === 'scoping').status, 'completed');
  assert.equal(restored.project.stageGraph.stages.find((stage) => stage.key === 'evidence').status, 'not_applicable');
  assert.equal(restored.project.stageGraph.stages.find((stage) => stage.key === 'evidence').notApplicableReason, 'The project uses only locally generated simulation output.');
  console.log('OK   Product state survives an Electron restart');

  const interruptedConversation = {
    ...restored.conversations.find((conversation) => conversation.id === expectedId),
    messages: [
      ...restored.conversations.find((conversation) => conversation.id === expectedId).messages,
      {
        id: 'interrupted-assistant',
        role: 'assistant',
        content: 'Partial evidence summary',
        status: 'running',
        statusText: '正在研究',
        runId: 'interrupted-run',
        createdAt: '2026-11-17T00:16:00.000Z',
      },
    ],
    activeRun: {
      runId: 'interrupted-run',
      assistantId: 'interrupted-assistant',
      startedAt: '2026-11-17T00:16:00.000Z',
      status: 'running',
    },
    updatedAt: '2026-11-17T00:16:00.000Z',
  };
  const recoveryRunDirectory = path.join(workspace, '.science', 'runs', expectedId, 'interrupted-run');
  mkdirSync(recoveryRunDirectory, { recursive: true });
  writeFileSync(path.join(recoveryRunDirectory, 'manifest.json'), JSON.stringify({
    runId: 'interrupted-run',
    conversationId: expectedId,
    status: 'running',
    startedAt: '2026-11-17T00:16:00.000Z',
    lastStep: 'Extracting evidence',
  }), 'utf8');
  await evaluate(cdp, `window.scienceAgent.conversationUpdate(${JSON.stringify(interruptedConversation)})`);
  await stopApp({ graceful: false });
  cdp = await connect(await launchApp());
  await waitForRenderer(cdp);
  await waitForActiveConversation(cdp, expectedId);
  const recoveredRunState = await evaluate(cdp, 'window.scienceAgent.productStateLoad()');
  const recoveredConversation = recoveredRunState.conversations.find((conversation) => conversation.id === expectedId);
  assert.equal(recoveredConversation.messages.find((message) => message.id === 'interrupted-assistant').status, 'needs-review');
  assert.equal(recoveredConversation.activeRun.status, 'running');
  assert.equal(recoveredConversation.activeRun.recoveryStatus, 'needs-review');
  assert.equal(recoveredConversation.activeRun.runId, 'interrupted-run');
  assert.equal(recoveredConversation.activeRun.manifest.lastStep, 'Extracting evidence');
  assert.equal(recoveredConversation.activeRun.manifestPath, `.science/runs/${expectedId}/interrupted-run/manifest.json`);
  assert.equal(await evaluate(cdp, `Boolean(document.querySelector('[data-continue-run]'))`), true);
  console.log('OK   Interrupted runs recover as needs-review with their run association');

  await evaluate(cdp, `(() => {
    const select = document.querySelector('#research-mode');
    select.value = 'literature';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await stopApp();
  cdp = await connect(await launchApp());
  await waitForRenderer(cdp);
  await waitForActiveConversation(cdp, expectedId);
  const flushed = await evaluate(cdp, 'window.scienceAgent.productStateLoad()');
  assert.equal(flushed.conversations.find((conversation) => conversation.id === expectedId).researchMode, 'literature');
  console.log('OK   Renderer state flushes before repository close');

  const legacyConversation = {
    id: 'legacy-conversation',
    title: 'Migrated browser thread',
    createdAt: '2026-11-16T00:00:00.000Z',
    updatedAt: '2026-11-16T00:10:00.000Z',
    messages: [{ id: 'legacy-message', role: 'user', content: 'Migrate me once.', createdAt: '2026-11-16T00:01:00.000Z' }],
    activities: [],
    evidenceMode: true,
    researchMode: 'literature',
  };
  await evaluate(cdp, `localStorage.setItem('scientia.conversations.v1', ${JSON.stringify(JSON.stringify([legacyConversation]))}); localStorage.setItem('scientia.ui.v1.active', 'legacy-conversation'); true`);
  await stopApp();

  for (const databaseFile of await findProductDatabaseFiles(userData)) rmSync(databaseFile, { force: true });
  cdp = await connect(await launchApp());
  await waitForRenderer(cdp);
  await delay(1000);
  await waitForActiveConversation(cdp, 'legacy-conversation');
  let migratedState = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await evaluate(cdp, `Promise.all([
      window.scienceAgent.productStateLoad(),
      Promise.resolve(localStorage.getItem('scientia.conversations.v1')),
    ])`);
    if (result[1] === null && result[0].conversations.some((conversation) => conversation.id === 'legacy-conversation')) {
      migratedState = result[0];
      break;
    }
    await delay(100);
  }
  assert.ok(migratedState, 'legacy browser conversations were not migrated');
  assert.equal(migratedState.activeId, 'legacy-conversation');
  assert.equal(migratedState.conversations.length, 1);
  assert.equal(migratedState.conversations[0].messages[0].content, 'Migrate me once.');
  console.log('OK   Browser-local conversations migrate once through the application');

  await stopApp();
  const configPath = await findFile(userData, 'science-agent.json');
  assert.ok(configPath, 'application config file was not found');
  const staleConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  staleConfig.workspace = 'C:\\Research\\Stale-Workspace';
  writeFileSync(configPath, JSON.stringify(staleConfig, null, 2), 'utf8');
  cdp = await connect(await launchApp());
  await waitForRenderer(cdp);
  const repairedConfig = await evaluate(cdp, 'window.scienceAgent.configLoad()');
  assert.equal(repairedConfig.workspace, migratedState.project.workspacePath);
  console.log('OK   The Research Workspace remains canonical across config writes');

  await stopApp();
  writeFileSync(configPath, '{ broken json', 'utf8');
  cdp = await connect(await launchApp());
  await waitForRenderer(cdp);
  const stateAfterCorruptConfig = await evaluate(cdp, 'window.scienceAgent.productStateLoad()');
  assert.equal(stateAfterCorruptConfig.activeProjectId, migratedState.activeProjectId);
  assert.equal(stateAfterCorruptConfig.project.workspacePath, migratedState.project.workspacePath);
  console.log('OK   Corrupt derived config does not hide canonical Research Project state');

  const corruptConfigProjectName = 'Research Project Created With Corrupt Config';
  await evaluate(cdp, `document.querySelector('#add-project').click(); (() => {
    document.querySelector('#project-name').value = ${JSON.stringify(corruptConfigProjectName)};
    document.querySelector('#create-project').click();
    return true;
  })()`);
  await waitForActiveResearchProject(cdp, { name: corruptConfigProjectName });

  await evaluate(cdp, `document.querySelector('[data-project-id="${migratedState.activeProjectId}"]').click()`);
  await waitForActiveResearchProject(cdp, {
    id: migratedState.activeProjectId,
    name: migratedState.project.name,
  });
  console.log('OK   Research Project mutations remain usable with corrupt derived config');

  await stopApp();
  for (const databaseFile of await findProductDatabaseFiles(userData)) rmSync(databaseFile, { force: true });
  writeFileSync(configPath, '{ still broken', 'utf8');
  cdp = await connect(await launchApp());
  await waitForRenderer(cdp);
  const pendingState = await evaluate(cdp, 'window.scienceAgent.productStateLoad()');
  assert.equal(pendingState.requiresResearchWorkspaceBinding, true);
  assert.deepEqual(pendingState.projects, []);
  assert.equal(await evaluate(cdp, `Boolean(document.querySelector('#choose-settings-research-workspace'))`), true);
  const recoveredWorkspace = path.join(userData, 'recovered-research-workspace');
  await evaluate(cdp, `(() => {
    document.querySelector('#settings-workspace-path').value = ${JSON.stringify(recoveredWorkspace)};
    document.querySelector('#settings-form').requestSubmit();
    return true;
  })()`);
  const boundState = await pollUntil(
    () => evaluate(cdp, 'window.scienceAgent.productStateLoad()'),
    (state) => state.project?.workspacePath === recoveredWorkspace,
  );
  assert.equal(boundState.requiresResearchWorkspaceBinding, false);
  assert.equal(boundState.project.name, 'Research Project');
  const recoveredConfig = await pollUntil(
    () => evaluate(cdp, 'window.scienceAgent.configLoad()'),
    (config) => config.workspace === recoveredWorkspace,
  );
  assert.equal(recoveredConfig.workspace, recoveredWorkspace);
  console.log('OK   Explicit save binds a pending Research Project and repairs derived config');
} finally {
  await stopApp();
  rmSync(userData, { recursive: true, force: true });
}
