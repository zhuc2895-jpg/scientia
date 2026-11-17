import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];

checks.push(['Node.js', process.versions.node, Number(process.versions.node.split('.')[0]) >= 22]);
checks.push(['Electron package', existsSync(path.join(root, 'node_modules', 'electron')) ? 'installed' : 'missing', existsSync(path.join(root, 'node_modules', 'electron'))]);

const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const pythonExists = existsSync(python);
checks.push(['Python venv', pythonExists ? python : 'missing', pythonExists]);
if (pythonExists) {
  const result = spawnSync(python, ['-c', 'import deepseek_harness; print("ok")'], { cwd: root, encoding: 'utf8' });
  checks.push(['DeepSeek Harness SDK', result.status === 0 ? 'installed' : (result.stderr || 'missing').trim(), result.status === 0]);
  if (result.status === 0) {
    const profile = spawnSync(python, ['scripts/profile_check.py'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PYTHONUTF8: '1', DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || 'sk-scientia-doctor' },
    });
    checks.push([
      'Research profile',
      profile.status === 0 ? 'file + web tools ready' : (profile.stderr || profile.stdout || 'profile failed').trim(),
      profile.status === 0,
    ]);
  }
}

for (const [name, value, ok] of checks) {
  console.log(`${ok ? 'OK ' : 'ERR'}  ${name}: ${value}`);
}
if (checks.some(([, , ok]) => !ok)) process.exitCode = 1;
