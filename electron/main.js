import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell, Tray } from 'electron';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDaemonManager } from './runtime.js';
import { openProductRepository } from './product-repository.js';
import { createAppLifecycle } from './app-lifecycle.js';
import { readRunManifest } from './run-recovery.js';
import { captureSecretFromUser } from './native-secret-input.js';
import { createImportAuthorizer } from './import-authorizer.js';
import { resolveWorkspaceEntry } from './workspace-paths.js';
import { removeManagedProjectWorkspace } from './project-workspace.js';
import { pathKey } from './path-boundary.js';
import { createConfigStore } from './config-store.js';
import { createResearchProjectLifecycle } from './research-project-lifecycle.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_MAX_TOKENS = 49152;
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.idea', '.vscode']);
let mainWindow = null;
let sessionApiKey = '';
let cachedHarnessStatus = null;
let runtimeManager = null;
let productRepository = null;
let researchProjectLifecycle = null;
let tray = null;
const importAuthorizer = createImportAuthorizer();
const projectWorkspaceAuthorizer = createImportAuthorizer();
const appLifecycle = createAppLifecycle({
  app,
  getWindow: () => mainWindow,
  stopRuntime: () => runtimeManager?.stop(),
});

function configPath() {
  return path.join(app.getPath('userData'), 'science-agent.json');
}

function productDatabasePath() {
  return path.join(app.getPath('userData'), 'scientia-product.sqlite3');
}

function defaultWorkspace() {
  return path.join(os.homedir(), 'ScienceAgent');
}

function emptyConfig() {
  return {
    baseUrl: '',
    model: DEFAULT_MODEL,
    maxTokens: DEFAULT_MAX_TOKENS,
    workspace: defaultWorkspace(),
    apiKeyEncrypted: '',
  };
}

let configStore = null;

function getConfigStore() {
  if (!configStore) configStore = createConfigStore({ filePath: configPath(), defaults: emptyConfig });
  return configStore;
}

async function hydrateSecret(config) {
  if (!config.apiKeyEncrypted) return '';
  if (!safeStorage.isEncryptionAvailable()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(config.apiKeyEncrypted, 'base64'));
  } catch {
    return '';
  }
}

function publicConfig(config, harness) {
  return {
    baseUrl: config.baseUrl || '',
    model: config.model || DEFAULT_MODEL,
    maxTokens: Number(config.maxTokens) || DEFAULT_MAX_TOKENS,
    workspace: productRepository?.getActiveResearchWorkspacePath() || '',
    apiKeyPresent: Boolean(sessionApiKey),
    apiKeyPersisted: Boolean(config.apiKeyEncrypted),
    safeStorageAvailable: safeStorage.isEncryptionAvailable(),
    harnessInstalled: Boolean(harness?.installed),
    harnessError: harness?.error || '',
    daemon: runtimeManager?.getState() || { state: 'unconfigured', activeRunId: null, pid: null },
  };
}

function normalizeWorkspace(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error('Research Workspace 必须是绝对路径。');
  }
  return path.resolve(value);
}

async function ensureResearchWorkspace(workspace) {
  await fs.mkdir(workspace, { recursive: true });
  return fs.realpath(workspace);
}

function currentProjectWorkspace() {
  const researchWorkspace = productRepository?.getActiveResearchWorkspacePath();
  if (!researchWorkspace) throw new Error('Research Project 尚未绑定 Research Workspace。');
  return normalizeWorkspace(researchWorkspace);
}

function managedWorkspacesRoot() {
  return path.join(app.getPath('userData'), 'managed-workspaces');
}

function assertNoActiveResearchRun() {
  const daemon = runtimeManager?.getState();
  if (daemon?.activeRunId || daemon?.state === 'running') {
    throw new Error('当前 Research Project 有 Research Run，请先停止。');
  }
}

async function assertWorkspaceDirectory(workspacePath) {
  const resolved = normalizeWorkspace(workspacePath);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error('导入路径不是目录。');
  return fs.realpath(resolved);
}

function pythonExecutable() {
  const candidates = [
    process.env.SCIENTIA_PYTHON,
    path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
    path.join(ROOT, '.venv', 'bin', 'python'),
    path.join(process.resourcesPath || '', 'python', 'python.exe'),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

async function checkHarness() {
  if (cachedHarnessStatus) return cachedHarnessStatus;
  const python = pythonExecutable();
  if (!python) {
    cachedHarnessStatus = { installed: false, error: '未找到 Python 环境，请先运行 npm run setup:python。' };
    return cachedHarnessStatus;
  }
  cachedHarnessStatus = await new Promise((resolve) => {
    const child = spawn(python, ['-c', 'import deepseek_harness; print("ok")'], {
      cwd: ROOT,
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1' },
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ installed: false, error: 'DeepSeek Harness 检查超时。' });
    }, 10000);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ installed: false, error: error.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0
        ? { installed: true, error: '' }
        : { installed: false, error: stderr.trim() || 'DeepSeek Harness SDK 未安装。' });
    });
  });
  return cachedHarnessStatus;
}

async function currentPublicConfig() {
  const config = await getConfigStore().read();
  const harness = await checkHarness();
  return publicConfig(config, harness);
}

async function saveApiKey(apiKey) {
  const next = await getConfigStore().update((previous) => ({
    ...previous,
    apiKeyEncrypted: apiKey && safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(apiKey).toString('base64')
      : '',
  }));
  sessionApiKey = apiKey;
  cachedHarnessStatus = null;
  if (runtimeManager) await runtimeManager.restart();
  return publicConfig(next, await checkHarness());
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 680,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    title: 'SCIENTIA — Science Agent',
    icon: path.join(ROOT, 'app', 'assets', 'icon.png'),
    backgroundColor: '#e7e9ed',
    webPreferences: {
      preload: path.join(ROOT, 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  appLifecycle.attachWindow(mainWindow);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault();
  });
  mainWindow.loadFile(path.join(ROOT, 'app', 'index.html'));
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) return;
  tray = new Tray(path.join(ROOT, 'app', 'assets', 'icon.png'));
  tray.setToolTip('SCIENTIA — Science Agent');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 SCIENTIA', click: showMainWindow },
    { type: 'separator' },
    { label: '退出 SCIENTIA', click: () => appLifecycle.requestQuit() },
  ]));
  tray.on('click', showMainWindow);
}

function classifyExtension(ext) {
  if (['.pdf', '.doc', '.docx', '.md', '.txt', '.tex', '.rtf'].includes(ext)) return 'documents';
  if (['.csv', '.tsv', '.xlsx', '.xls', '.json', '.jsonl', '.parquet', '.h5', '.hdf5', '.nc', '.mat', '.rds', '.sav'].includes(ext)) return 'data';
  if (['.py', '.r', '.m', '.jl', '.js', '.ts', '.ipynb', '.sql', '.sh', '.ps1'].includes(ext)) return 'code';
  if (['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.svg'].includes(ext)) return 'images';
  return 'other';
}

async function readResearchSummary(workspace, files) {
  const outputFiles = files.filter((file) => file.relativePath.startsWith('.science/outputs/'));
  const inputFiles = files.filter((file) => file.relativePath.startsWith('.science/inputs/'));
  const evidenceFiles = files.filter((file) => file.relativePath.startsWith('.science/evidence/') && file.relativePath.endsWith('.jsonl'));
  let evidenceCount = 0;
  for (const file of evidenceFiles.slice(0, 24)) {
    try {
      const text = await fs.readFile(path.join(workspace, file.relativePath), 'utf8');
      evidenceCount += text.split(/\r?\n/).filter((line) => line.trim()).length;
    } catch { /* unreadable ledgers are omitted from the summary */ }
  }

  const runFiles = files
    .filter((file) => file.relativePath.startsWith('.science/runs/') && file.relativePath.endsWith('/manifest.json'))
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  let latestRun = null;
  if (runFiles[0]) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(workspace, runFiles[0].relativePath), 'utf8'));
      latestRun = {
        runId: manifest.runId || null,
        status: manifest.status || 'unknown',
        mode: manifest.mode || 'auto',
        startedAt: manifest.startedAt || null,
        finishedAt: manifest.finishedAt || null,
        outputDir: manifest.outputDir || null,
        evidenceAdded: Number(manifest.evidenceAdded) || 0,
        warnings: Number(manifest.quality?.warnings) || 0,
      };
    } catch { /* ignore malformed historic run records */ }
  }

  return {
    inputCount: inputFiles.length,
    outputCount: outputFiles.length,
    evidenceCount,
    latestRun,
    outputs: outputFiles.slice(0, 12),
  };
}
async function inspectWorkspace(workspaceInput) {
  const workspace = normalizeWorkspace(workspaceInput);
  await ensureResearchWorkspace(workspace);
  const counts = { documents: 0, data: 0, code: 0, images: 0, other: 0 };
  const files = [];
  const stack = [workspace];
  let totalFiles = 0;
  let totalBytes = 0;

  while (stack.length && totalFiles < 6000) {
    const directory = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.science') continue;
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      let stat;
      try { stat = await fs.stat(absolute); } catch { continue; }
      const ext = path.extname(entry.name).toLowerCase();
      const kind = classifyExtension(ext);
      counts[kind] += 1;
      totalFiles += 1;
      totalBytes += stat.size;
      if (files.length < 1200) {
        files.push({
          name: entry.name,
          relativePath: path.relative(workspace, absolute).split(path.sep).join('/'),
          kind,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          generated: path.relative(workspace, absolute).split(path.sep).join('/').startsWith('.science/outputs/'),
        });
      }
    }
  }

  files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  const research = await readResearchSummary(workspace, files);
  return {
    workspace,
    counts,
    totalFiles,
    totalBytes,
    recent: files.slice(0, 16),
    research,
  };
}

async function uniqueDestination(directory, filename) {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120) || 'file';
  let candidate = path.join(directory, `${stem}${ext}`);
  let index = 2;
  while (existsSync(candidate)) {
    candidate = path.join(directory, `${stem}-${index}${ext}`);
    index += 1;
  }
  return candidate;
}

async function importFiles(workspaceInput, tokens) {
  const filePaths = importAuthorizer.consume(tokens);
  const workspace = await ensureResearchWorkspace(normalizeWorkspace(workspaceInput));
  if (filePaths.length === 0) return [];
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const destinationDir = path.join(workspace, '.science', 'inputs', stamp);
  await fs.mkdir(destinationDir, { recursive: true });
  const imported = [];
  for (const source of filePaths) {
    if (typeof source !== 'string' || !path.isAbsolute(source)) continue;
    let stat;
    try { stat = await fs.stat(source); } catch { continue; }
    if (!stat.isFile()) continue;
    const destination = await uniqueDestination(destinationDir, path.basename(source));
    await fs.copyFile(source, destination);
    imported.push({
      name: path.basename(destination),
      relativePath: path.relative(workspace, destination).split(path.sep).join('/'),
      size: stat.size,
    });
  }
  return imported;
}

async function runAgent(payload, sender) {
  if (!runtimeManager) throw new Error('Science Agent runtime is not ready.');
  const state = productRepository.loadState();
  const conversationProjectId = productRepository.getConversationProjectId(payload?.conversationId);
  const researchWorkspace = productRepository.getActiveResearchWorkspacePath();
  if (!state.activeProjectId || conversationProjectId !== state.activeProjectId || !researchWorkspace) {
    throw new Error('只能运行当前 Research Project 中的 Conversation。');
  }
  const stageKey = state.project?.stageGraph?.currentStageKey || null;
  const approvedCharter = state.project?.charter?.approved || null;
  if (stageKey !== 'scoping' && !approvedCharter) {
    throw new Error('进入 Evidence 后，Research Run 必须引用当前已批准的 Research Charter。');
  }
  const enrichedPayload = {
    ...payload,
    projectId: state.activeProjectId,
    stageKey,
    researchCharter: approvedCharter,
    charterDraftMode: stageKey === 'scoping' && !approvedCharter,
  };
  return runtimeManager.run(enrichedPayload, sender, researchWorkspace);
}

async function cancelAgent(runId) {
  if (!runtimeManager) return { cancelled: false };
  return runtimeManager.cancel(runId);
}

function installIpc() {
  ipcMain.handle('config:load', currentPublicConfig);

  ipcMain.handle('product:load', () => productRepository.loadState());
  ipcMain.handle('product:migrate', (_event, payload) => productRepository.migrateLegacyState({
    conversations: payload?.conversations,
    activeId: typeof payload?.activeId === 'string' ? payload.activeId : null,
  }));

  ipcMain.handle('project:pick-import', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入已有 Research Workspace',
      properties: ['openDirectory'],
    });
    if (result.canceled) return null;
    const workspacePath = result.filePaths[0];
    const [token] = projectWorkspaceAuthorizer.authorize([workspacePath]);
    return { token, path: workspacePath, suggestedName: path.basename(workspacePath) || 'Research Project' };
  });

  ipcMain.handle('project:create-managed', async (_event, payload) => {
    assertNoActiveResearchRun();
    const id = randomUUID();
    const workspacePath = path.join(managedWorkspacesRoot(), id);
    await fs.mkdir(workspacePath, { recursive: true });
    try {
      return await researchProjectLifecycle.createResearchProject({
        id,
        name: payload?.name,
        workspacePath,
        workspaceKind: 'managed',
      });
    } catch (error) {
      try {
        await removeManagedProjectWorkspace({
          managedRoot: managedWorkspacesRoot(),
          project: { workspacePath, workspaceKind: 'managed' },
        });
      } catch { /* preserve the original creation error */ }
      throw error;
    }
  });

  ipcMain.handle('project:create-imported', async (_event, payload) => {
    assertNoActiveResearchRun();
    const token = typeof payload?.token === 'string' ? payload.token : '';
    const [grantedPath] = projectWorkspaceAuthorizer.consume(token ? [token] : []);
    if (!grantedPath) throw new Error('导入目录授权无效或已过期，请重新选择。');
    const workspacePath = await assertWorkspaceDirectory(grantedPath);
    return researchProjectLifecycle.createResearchProject({
      id: randomUUID(),
      name: payload?.name || path.basename(workspacePath),
      workspacePath,
      workspaceKind: 'imported',
    });
  });

  ipcMain.handle('project:activate', async (_event, id) => {
    assertNoActiveResearchRun();
    return researchProjectLifecycle.activateResearchProject(id);
  });

  ipcMain.handle('project:archive', async (_event, id) => {
    assertNoActiveResearchRun();
    return researchProjectLifecycle.archiveResearchProject(id);
  });

  ipcMain.handle('project:restore', async (_event, id) => {
    assertNoActiveResearchRun();
    return researchProjectLifecycle.restoreResearchProject(id);
  });

  ipcMain.handle('project:delete', async (_event, payload) => {
    assertNoActiveResearchRun();
    return researchProjectLifecycle.deleteResearchProject({
      id: payload?.id,
      confirmationName: payload?.confirmationName,
      cleanupManagedResearchWorkspace: (project) => removeManagedProjectWorkspace({
        managedRoot: managedWorkspacesRoot(),
        project,
        protectedPaths: productRepository.getBoundResearchWorkspacePaths(),
      }),
    });
  });

  ipcMain.handle('project:charter-save-draft', (_event, payload) => {
    const source = payload?.source === 'agent' ? 'agent' : 'user';
    if (source !== 'agent') assertNoActiveResearchRun();
    return productRepository.saveResearchCharterDraft({
      charter: payload?.charter,
      source,
      generatedByRunId: typeof payload?.generatedByRunId === 'string' ? payload.generatedByRunId : null,
    });
  });
  ipcMain.handle('project:charter-approve', (_event, payload) => {
    assertNoActiveResearchRun();
    return productRepository.approveResearchCharter({ charter: payload?.charter });
  });
  ipcMain.handle('project:stage-complete', (_event, stageKey) => {
    assertNoActiveResearchRun();
    return productRepository.completeResearchStage(stageKey);
  });
  ipcMain.handle('project:stage-not-applicable', (_event, payload) => {
    assertNoActiveResearchRun();
    return productRepository.markResearchStageNotApplicable({
      stageKey: payload?.stageKey,
      reason: payload?.reason,
    });
  });
  ipcMain.handle('project:stage-reopen', (_event, stageKey) => {
    assertNoActiveResearchRun();
    return productRepository.reopenResearchStage(stageKey);
  });

  ipcMain.handle('conversation:create', (_event, conversation) => productRepository.createConversation(conversation));
  ipcMain.handle('conversation:update', (_event, conversation) => productRepository.updateConversation(conversation));
  ipcMain.handle('conversation:delete', (_event, id) => productRepository.deleteConversation(id));
  ipcMain.handle('conversation:set-active', (_event, id) => productRepository.setActiveConversation(id));
  ipcMain.on('product:flush', (event, payload) => {
    try {
      const conversations = Array.isArray(payload?.conversations)
        ? payload.conversations
        : payload?.conversation
          ? [payload.conversation]
          : [];
      for (const conversation of conversations) productRepository.updateConversation(conversation);
      if (Object.hasOwn(payload || {}, 'activeId')) productRepository.setActiveConversation(payload.activeId);
      event.returnValue = { ok: true };
    } catch (error) {
      console.error('[science-agent] product state flush failed:', error);
      dialog.showErrorBox('SCIENTIA 无法保存会话', error.message || '产品状态写入失败。');
      event.returnValue = { ok: false, error: error.message || '无法保存产品状态。' };
    }
  });

  ipcMain.handle('config:save', async (_event, payload) => {
    const result = await researchProjectLifecycle.saveConfiguration({
      requestedResearchWorkspace: payload?.workspace,
      configurationValues: {
        baseUrl: typeof payload?.baseUrl === 'string' ? payload.baseUrl.trim().replace(/\/+$/, '') : '',
        model: typeof payload?.model === 'string' && payload.model.trim() ? payload.model.trim() : DEFAULT_MODEL,
        maxTokens: Math.min(200000, Math.max(4096, Number(payload?.maxTokens) || DEFAULT_MAX_TOKENS)),
      },
      ensureResearchWorkspace,
    });
    cachedHarnessStatus = null;
    if (!result.configError && runtimeManager) await runtimeManager.restart();
    return {
      ...publicConfig(result.configuration || {}, await checkHarness()),
      productState: result.productState,
      configError: result.configError?.message || '',
    };
  });
  ipcMain.handle('secret:set-api-key', async () => {
    const apiKey = await captureSecretFromUser();
    return saveApiKey(apiKey);
  });
  ipcMain.handle('secret:clear-api-key', async () => saveApiKey(''));

  ipcMain.handle('research-workspace:pick', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 Research Workspace',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.handle('workspace:inspect', async () => inspectWorkspace(currentProjectWorkspace()));
  ipcMain.handle('workspace:open', async () => shell.openPath(await ensureResearchWorkspace(currentProjectWorkspace())));
  ipcMain.handle('path:open', async (_event, { relativePath }) => {
    const resolved = await resolveWorkspaceEntry(currentProjectWorkspace(), relativePath);
    return shell.openPath(resolved);
  });
  ipcMain.handle('path:reveal', async (_event, { relativePath }) => {
    const resolved = await resolveWorkspaceEntry(currentProjectWorkspace(), relativePath);
    shell.showItemInFolder(resolved);
  });

  ipcMain.handle('files:pick', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入研究资料',
      properties: ['openFile', 'multiSelections'],
    });
    return result.canceled ? [] : importAuthorizer.authorize(result.filePaths);
  });
  ipcMain.handle('files:authorize-dropped', async (_event, { paths }) => importAuthorizer.authorize(paths));
  ipcMain.handle('files:import', async (_event, { tokens }) => importFiles(currentProjectWorkspace(), tokens));
  ipcMain.handle('agent:run', async (event, payload) => runAgent(payload, event.sender));
  ipcMain.handle('agent:cancel', async (_event, runId) => cancelAgent(runId));
  ipcMain.handle('research:recover-run', async (_event, payload) => {
    const workspace = normalizeWorkspace(payload?.workspace);
    const projectWorkspace = productRepository.getActiveResearchWorkspacePath();
    if (!projectWorkspace || pathKey(workspace) !== pathKey(projectWorkspace)) {
      throw new Error('只能从当前 Research Project 的 Research Workspace 恢复运行。');
    }
    return readRunManifest({
      workspace,
      conversationId: payload?.conversationId,
      runId: payload?.runId,
    });
  });
  ipcMain.handle('app:runtime', async () => ({
    platform: process.platform,
    version: app.getVersion(),
    electron: process.versions.electron,
    workspaceDefault: defaultWorkspace(),
    dshHome: path.join(app.getPath('userData'), 'dsh-home'),
  }));
  ipcMain.handle('app:open-data', async () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('app:quit', () => {
    appLifecycle.requestQuit();
    return true;
  });
  ipcMain.handle('external:open', async (_event, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle('window:control', (_event, action) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (action === 'minimize') mainWindow.minimize();
    else if (action === 'maximize') {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    } else if (action === 'close') mainWindow.close();
    else return false;
    return true;
  });
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    let config = null;
    let configReadError = null;
    try {
      config = await getConfigStore().read();
    } catch (error) {
      configReadError = error;
      console.error('[science-agent] config read failed:', error);
    }
    sessionApiKey = config ? await hydrateSecret(config) : '';
    productRepository = openProductRepository({ databasePath: productDatabasePath() });
    researchProjectLifecycle = createResearchProjectLifecycle({
      productRepository,
      configStore: getConfigStore(),
      validateResearchWorkspace: assertWorkspaceDirectory,
      onConfigSyncError: (error) => console.error('[science-agent] Research Project configuration synchronization failed:', error),
    });
    await researchProjectLifecycle.initializeResearchProjectState({
      configuredResearchWorkspace: config?.workspace || (configReadError ? '' : defaultWorkspace()),
      ensureResearchWorkspace,
    });
    runtimeManager = createDaemonManager({
      app,
      rootPath: ROOT,
      getApiKey: () => sessionApiKey,
      checkHarness,
      pythonExecutable,
      readConfigFile: () => getConfigStore().read(),
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
    });
    installIpc();
    createWindow();
    createTray();
    void runtimeManager.start().catch((error) => console.error('[science-agent] daemon start failed:', error));
    app.on('activate', () => {
      if (mainWindow && !mainWindow.isDestroyed()) showMainWindow();
      else createWindow();
    });
  }).catch((error) => {
    console.error('[science-agent] startup failed:', error);
    dialog.showErrorBox('SCIENTIA 无法启动', error.message || '本地产品数据库初始化失败。');
    app.quit();
  });

  app.on('before-quit', appLifecycle.handleBeforeQuit);

  app.on('will-quit', () => {
    tray?.destroy();
    tray = null;
    productRepository?.close();
    productRepository = null;
    researchProjectLifecycle = null;
  });
}
