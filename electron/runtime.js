import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BrowserWindow } from 'electron';

const RESTART_DELAYS = [1000, 2000, 5000, 10000, 30000];

export function createDaemonManager({
  app,
  rootPath,
  getApiKey,
  checkHarness,
  pythonExecutable,
  readConfigFile,
  defaultMaxTokens,
}) {
  let child = null;
  let ready = false;
  let intentionalStop = false;
  let restartAttempt = 0;
  let restartTimer = null;
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let readyWaiter = null;
  let state = { state: 'unconfigured', activeRunId: null, pid: null };
  const runSenders = new Map();
  const runTimers = new Map();

  function setState(next) {
    state = { ...state, ...next };
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('agent:event', { type: 'daemon_status', ...state });
    }
  }

  function broadcast(message) {
    const target = message?.runId ? runSenders.get(message.runId) : null;
    if (target && !target.isDestroyed()) {
      target.send('agent:event', message);
      return;
    }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('agent:event', message);
    }
  }

  function clearRun(runId) {
    const timer = runTimers.get(runId);
    if (timer) clearTimeout(timer);
    runTimers.delete(runId);
    runSenders.delete(runId);
  }

  function terminateTree(process) {
    if (!process || process.killed) return;
    if (globalThis.process.platform === 'win32' && process.pid) {
      const killer = spawn('taskkill', ['/PID', String(process.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => process.kill());
      return;
    }
    process.kill('SIGTERM');
  }

  function consumeLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      broadcast({ type: 'log', message: line.slice(0, 1000) });
      return;
    }
    if (message.type === 'ready') {
      ready = true;
      restartAttempt = 0;
      setState({ state: 'ready', pid: child?.pid || null, activeRunId: null });
      if (readyWaiter) {
        readyWaiter(true);
        readyWaiter = null;
      }
      return;
    }
    if (message.type === 'status') {
      setState({
        state: message.state || state.state,
        activeRunId: message.activeRunId || null,
        pid: child?.pid || state.pid,
      });
      broadcast(message);
      return;
    }
    if (message.type === 'stderr') {
      console.error(`[science-agent] ${message.message || ''}`);
      return;
    }
    if (message.type === 'result' || message.type === 'error' || message.type === 'cancelled') {
      broadcast(message);
      if (message.runId) clearRun(message.runId);
      return;
    }
    broadcast(message);
  }

  function scheduleRestart() {
    if (intentionalStop || restartTimer) return;
    const delay = RESTART_DELAYS[Math.min(restartAttempt, RESTART_DELAYS.length - 1)];
    restartAttempt += 1;
    setState({ state: 'restarting', activeRunId: null });
    restartTimer = setTimeout(() => {
      restartTimer = null;
      void start().catch((error) => {
        console.error('[science-agent] daemon restart failed:', error);
      });
    }, delay);
  }

  async function start() {
    if (child && ready) return true;
    if (child && !ready && readyWaiter) {
      return new Promise((resolve) => { readyWaiter = resolve; });
    }

    const apiKey = getApiKey();
    if (!apiKey) {
      setState({ state: 'unconfigured', activeRunId: null, pid: null });
      return false;
    }

    const harness = await checkHarness();
    if (!harness.installed) {
      setState({ state: 'failed', error: harness.error, activeRunId: null, pid: null });
      return false;
    }
    const python = pythonExecutable();
    if (!python) {
      setState({ state: 'failed', error: 'Python runtime is missing.', activeRunId: null, pid: null });
      return false;
    }

    const config = await readConfigFile();
    const systemPrompt = await fs.readFile(path.join(rootPath, 'science_agent', 'system_prompt.md'), 'utf8');
    const env = {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONUNBUFFERED: '1',
      DEEPSEEK_API_KEY: apiKey,
      DSH_MODEL: config.model || 'deepseek-v4-flash',
      DSH_SYSTEM_PROMPT: systemPrompt,
    };
    if (config.baseUrl) env.DEEPSEEK_BASE_URL = config.baseUrl;
    else delete env.DEEPSEEK_BASE_URL;

    intentionalStop = false;
    ready = false;
    stdoutBuffer = '';
    stderrBuffer = '';
    setState({ state: 'starting', activeRunId: null, pid: null, error: '' });

    const spawned = spawn(python, [path.join(rootPath, 'science_agent', 'daemon.py')], {
      cwd: rootPath,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child = spawned;

    spawned.stdout.setEncoding('utf8');
    spawned.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) consumeLine(line);
    });
    spawned.stderr.setEncoding('utf8');
    spawned.stderr.on('data', (chunk) => {
      stderrBuffer = (stderrBuffer + chunk).slice(-12000);
    });

    spawned.on('error', (error) => {
      console.error('[science-agent] daemon error:', error);
      if (readyWaiter) {
        readyWaiter(false);
        readyWaiter = null;
      }
      setState({ state: 'failed', error: error.message, activeRunId: null, pid: null });
    });

    spawned.on('exit', (code, signal) => {
      if (child !== spawned) return;
      child = null;
      ready = false;
      if (readyWaiter) {
        readyWaiter(false);
        readyWaiter = null;
      }
      const detail = stderrBuffer.trim();
      setState({
        state: intentionalStop ? 'stopped' : 'exited',
        activeRunId: null,
        pid: null,
        exitCode: code,
        signal,
        error: detail || (code && code !== 0 ? `Daemon exited with code ${code}.` : ''),
      });
      for (const [runId, sender] of runSenders.entries()) {
        if (!sender.isDestroyed()) {
          sender.send('agent:event', {
            type: 'error',
            runId,
            message: detail || 'The local Science Agent daemon exited unexpectedly.',
          });
        }
        clearRun(runId);
      }
      if (!intentionalStop) scheduleRestart();
    });

    return new Promise((resolve) => {
      readyWaiter = resolve;
      setTimeout(() => {
        if (readyWaiter === resolve) {
          readyWaiter = null;
          resolve(ready);
        }
      }, 10000).unref();
    });
  }

  async function run(payload, sender) {
    const runId = typeof payload?.runId === 'string' ? payload.runId : '';
    const conversationId = typeof payload?.conversationId === 'string' ? payload.conversationId : '';
    const prompt = typeof payload?.prompt === 'string' ? payload.prompt.trim() : '';
    if (!runId || !conversationId || !prompt) throw new Error('研究任务参数不完整。');
    if (prompt.length > 240000) throw new Error('单次任务文本过长，请拆分研究步骤。');

    const started = await start();
    if (!started || !child) throw new Error(state.error || 'Science Agent daemon is unavailable.');
    const config = await readConfigFile();
    const workspace = path.resolve(config.workspace);
    await fs.mkdir(workspace, { recursive: true });

    const request = {
      runId,
      conversationId,
      prompt,
      workspace,
      dshHome: path.join(app.getPath('userData'), 'dsh-home'),
      patchPath: path.join(rootPath, 'science_agent', 'harness.patch.yml'),
      maxTokens: Number(config.maxTokens) || defaultMaxTokens,
      evidenceMode: payload.evidenceMode !== false,
      mode: typeof payload.mode === 'string' ? payload.mode : 'auto',
    };
    runSenders.set(runId, sender);
    const timer = setTimeout(() => {
      if (child?.connected || child?.stdin?.writable) {
        try { child.stdin.write(`${JSON.stringify({ type: 'cancel', runId })}\n`); } catch { /* noop */ }
      }
      if (!sender.isDestroyed()) {
        sender.send('agent:event', { type: 'error', runId, message: '研究任务超过 45 分钟，已停止。' });
      }
      clearRun(runId);
    }, 45 * 60 * 1000);
    runTimers.set(runId, timer);

    try {
      child.stdin.write(`${JSON.stringify({ type: 'run', request })}\n`);
    } catch (error) {
      clearRun(runId);
      throw error;
    }
    setState({ state: 'running', activeRunId: runId, pid: child.pid });
    return { accepted: true, runId };
  }

  async function cancel(runId) {
    if (!child?.stdin?.writable || !runId) return { cancelled: false };
    child.stdin.write(`${JSON.stringify({ type: 'cancel', runId })}\n`);
    return { cancelled: true };
  }

  async function stop({ forRestart = false } = {}) {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (!child) {
      setState({ state: 'unconfigured', activeRunId: null, pid: null });
      return;
    }
    intentionalStop = true;
    const stopping = child;
    child = null;
    ready = false;
    try {
      if (stopping.stdin?.writable) stopping.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
    } catch { /* noop */ }
    const exited = new Promise((resolve) => stopping.once('exit', resolve));
    const timeout = new Promise((resolve) => setTimeout(resolve, 4000));
    await Promise.race([exited, timeout]);
    terminateTree(stopping);
    for (const runId of [...runSenders.keys()]) clearRun(runId);
    setState({ state: forRestart ? 'starting' : 'stopped', activeRunId: null, pid: null });
  }

  async function restart() {
    await stop({ forRestart: true });
    intentionalStop = false;
    restartAttempt = 0;
    return start();
  }

  function getState() {
    return { ...state };
  }

  return { start, run, cancel, stop, restart, getState };
}
