import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { spawn } from 'node:child_process';

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDaemonManager } from './runtime.js';
import { openProductRepository } from './product-repository.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_MAX_TOKENS = 49152;
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.idea', '.vscode']);
let mainWindow = null;
let sessionApiKey = '';
let cachedHarnessStatus = null;
let runtimeManager = null;
let productRepository = null;

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

async function readConfigFile() {
  try {
    const raw = await fs.readFile(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return { ...emptyConfig(), ...parsed };
  } catch {
    return emptyConfig();
  }
}

async function writeConfigFile(config) {
  const target = configPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  await fs.writeFile(temp, JSON.stringify(config, null, 2), 'utf8');
  await fs.rename(temp, target);
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
    workspace: config.workspace || defaultWorkspace(),
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
    throw new Error('研究目录必须是绝对路径。');
  }
  return path.resolve(value);
}

async function ensureWorkspace(workspace) {
  await fs.mkdir(workspace, { recursive: true });
  return workspace;
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
  const config = await readConfigFile();
  const harness = await checkHarness();
  return publicConfig(config, harness);
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
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault();
  });
  mainWindow.loadFile(path.join(ROOT, 'app', 'index.html'));
}

function safeWorkspacePath(workspace, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath) throw new Error('文件路径无效。');
  const resolved = path.resolve(workspace, relativePath);
  const prefix = path.resolve(workspace) + path.sep;
  if (resolved !== path.resolve(workspace) && !resolved.startsWith(prefix)) {
    throw new Error('文件不在当前研究目录中。');
  }
  return resolved;
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
  await ensureWorkspace(workspace);
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

async function importFiles(workspaceInput, filePaths) {
  const workspace = await ensureWorkspace(normalizeWorkspace(workspaceInput));
  if (!Array.isArray(filePaths) || filePaths.length === 0) return [];
  if (filePaths.length > 20) throw new Error('一次最多导入 20 个文件。');
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
  return runtimeManager.run(payload, sender);
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
  ipcMain.handle('conversation:create', (_event, conversation) => productRepository.createConversation(conversation));
  ipcMain.handle('conversation:update', (_event, conversation) => productRepository.updateConversation(conversation));
  ipcMain.handle('conversation:delete', (_event, id) => productRepository.deleteConversation(id));
  ipcMain.handle('conversation:set-active', (_event, id) => productRepository.setActiveConversation(id));
  ipcMain.on('product:flush', (event, payload) => {
    try {
      if (payload?.conversation) productRepository.updateConversation(payload.conversation);
      if (Object.hasOwn(payload || {}, 'activeId')) productRepository.setActiveConversation(payload.activeId);
      event.returnValue = { ok: true };
    } catch (error) {
      console.error('[science-agent] product state flush failed:', error);
      dialog.showErrorBox('SCIENTIA 无法保存会话', error.message || '产品状态写入失败。');
      event.returnValue = { ok: false, error: error.message || '无法保存产品状态。' };
    }
  });

  ipcMain.handle('config:save', async (_event, payload) => {
    const previous = await readConfigFile();
    if (typeof payload?.workspace !== 'string') throw new Error('请选择研究目录。');
    const workspace = await ensureWorkspace(normalizeWorkspace(payload.workspace));
    const next = {
      ...previous,
      baseUrl: typeof payload.baseUrl === 'string' ? payload.baseUrl.trim().replace(/\/+$/, '') : '',
      model: typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : DEFAULT_MODEL,
      maxTokens: Math.min(200000, Math.max(4096, Number(payload.maxTokens) || DEFAULT_MAX_TOKENS)),
      workspace,
    };
    const apiKey = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '';
    if (apiKey) {
      sessionApiKey = apiKey;
      next.apiKeyEncrypted = safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(apiKey).toString('base64')
        : '';
    } else if (payload.clearApiKey === true) {
      sessionApiKey = '';
      next.apiKeyEncrypted = '';
    }
    await writeConfigFile(next);
    cachedHarnessStatus = null;
    if (runtimeManager) await runtimeManager.restart();
    return publicConfig(next, await checkHarness());
  });

  ipcMain.handle('workspace:pick', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择研究目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('workspace:inspect', async (_event, workspace) => inspectWorkspace(workspace));
  ipcMain.handle('workspace:open', async (_event, workspace) => shell.openPath(await ensureWorkspace(normalizeWorkspace(workspace))));
  ipcMain.handle('path:open', async (_event, { workspace, relativePath }) => {
    const resolved = safeWorkspacePath(normalizeWorkspace(workspace), relativePath);
    return shell.openPath(resolved);
  });
  ipcMain.handle('path:reveal', async (_event, { workspace, relativePath }) => {
    const resolved = safeWorkspacePath(normalizeWorkspace(workspace), relativePath);
    shell.showItemInFolder(resolved);
  });

  ipcMain.handle('files:pick', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入研究资料',
      properties: ['openFile', 'multiSelections'],
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle('files:import', async (_event, { workspace, paths }) => importFiles(workspace, paths));
  ipcMain.handle('agent:run', async (event, payload) => runAgent(payload, event.sender));
  ipcMain.handle('agent:cancel', async (_event, runId) => cancelAgent(runId));
  ipcMain.handle('app:runtime', async () => ({
    platform: process.platform,
    version: app.getVersion(),
    electron: process.versions.electron,
    workspaceDefault: defaultWorkspace(),
    dshHome: path.join(app.getPath('userData'), 'dsh-home'),
  }));
  ipcMain.handle('app:open-data', async () => shell.openPath(app.getPath('userData')));
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
    const config = await readConfigFile();
    sessionApiKey = await hydrateSecret(config);
    productRepository = openProductRepository({ databasePath: productDatabasePath() });
    await ensureWorkspace(config.workspace || defaultWorkspace());
    runtimeManager = createDaemonManager({
      app,
      rootPath: ROOT,
      getApiKey: () => sessionApiKey,
      checkHarness,
      pythonExecutable,
      readConfigFile,
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
    });
    installIpc();
    createWindow();
    void runtimeManager.start().catch((error) => console.error('[science-agent] daemon start failed:', error));
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch((error) => {
    console.error('[science-agent] startup failed:', error);
    dialog.showErrorBox('SCIENTIA 无法启动', error.message || '本地产品数据库初始化失败。');
    app.quit();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    void runtimeManager?.stop();
  });

  app.on('will-quit', () => {
    productRepository?.close();
    productRepository = null;
  });
}
