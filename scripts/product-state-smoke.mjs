import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

async function waitForActiveConversation(cdp, conversationId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const active = await evaluate(cdp, `Boolean(document.querySelector('[data-conversation-id="${conversationId}"].active'))`);
    if (active) return;
    await delay(100);
  }
  throw new Error(`Conversation ${conversationId} did not become active in the renderer.`);
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
  await evaluate(cdp, 'window.scienceAgent.windowControl("close")');
  await delay(300);
  assert.equal(await evaluate(cdp, 'document.hidden'), true);
  assert.equal(child.exitCode, null);
  console.log('OK   Closing the window hides it without stopping the application');
  await stopApp();

  cdp = await connect(await launchApp());
  await waitForRenderer(cdp);
  const isolatedWorkspace = path.join(userData, 'research-workspace');
  await evaluate(cdp, `(async () => {
    const config = await window.scienceAgent.configLoad();
    return window.scienceAgent.configSave({ ...config, workspace: ${JSON.stringify(isolatedWorkspace)}, apiKey: '' });
  })()`);
  await evaluate(cdp, `document.querySelector('#new-research').click()`);
  await delay(250);
  const created = await evaluate(cdp, 'window.scienceAgent.productStateLoad()');
  assert.equal(created.conversations.length, 1);
  assert.equal(created.activeId, created.conversations[0].id);
  const expectedId = created.activeId;
  const workspaceGuard = await evaluate(cdp, `(async () => {
    const config = await window.scienceAgent.configLoad();
    const rebound = await window.scienceAgent.configSave({ ...config, workspace: 'C:\\\\Research\\\\Other Project', apiKey: '' })
      .then(() => ({ ok: true, message: '' }), (error) => ({ ok: false, message: error.message }));
    return { initialWorkspace: config.workspace, project: (await window.scienceAgent.productStateLoad()).project, rebound };
  })()`);
  assert.equal(workspaceGuard.project.workspacePath, workspaceGuard.initialWorkspace);
  assert.equal(workspaceGuard.rebound.ok, false);
  assert.match(workspaceGuard.rebound.message, /已有会话/);
  console.log('OK   Conversation ownership blocks silent workspace rebinding');
  const workspace = workspaceGuard.initialWorkspace;

  await evaluate(cdp, `document.querySelector('#new-research').click()`);
  await delay(250);
  const withSecondConversation = await evaluate(cdp, 'window.scienceAgent.productStateLoad()');
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
} finally {
  await stopApp();
  rmSync(userData, { recursive: true, force: true });
}
