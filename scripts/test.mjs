import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

function run(label, command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } });
  if (result.stdout?.trim()) process.stdout.write(result.stdout);
  if (result.stderr?.trim()) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    console.error(`FAIL ${label}`);
    process.exit(result.status || 1);
  }
  console.log(`OK   ${label}`);
}

for (const file of ['app/app.js', 'app/checkpoint-presentation.js', 'app/conversation-state.js', 'app/research-charter.js', 'app/research-run-policy.js', 'app/research-stages.js', 'app/source-library.js', 'electron/app-lifecycle.js', 'electron/config-store.js', 'electron/import-authorizer.js', 'electron/main.js', 'electron/native-secret-input.js', 'electron/path-boundary.js', 'electron/product-repository.js', 'electron/research-project-lifecycle.js', 'electron/project-workspace.js', 'electron/source-ingestion.js', 'electron/source-revision.js', 'electron/source-verification.js', 'electron/run-recovery.js', 'electron/runtime.js', 'electron/workspace-paths.js', 'electron/preload.cjs']) {
  run(`syntax ${file}`, process.execPath, ['--check', file]);
}
run('Application state tests', process.execPath, [
  '--test',
  'electron/tests/app-lifecycle.test.mjs',
  'electron/tests/checkpoint-presentation.test.mjs',
  'electron/tests/config-store.test.mjs',
  'electron/tests/conversation-state.test.mjs',
  'electron/tests/import-authorizer.test.mjs',
  'electron/tests/native-secret-input.test.mjs',
  'electron/tests/product-repository.test.mjs',
  'electron/tests/research-charter.test.mjs',
  'electron/tests/research-run-policy.test.mjs',
  'electron/tests/research-project-lifecycle.test.mjs',
  'electron/tests/research-stages.test.mjs',
  'electron/tests/source-ingestion.test.mjs',
  'electron/tests/source-library.test.mjs',
  'electron/tests/source-revision.test.mjs',
  'electron/tests/source-verification.test.mjs',
  'electron/tests/project-workspace.test.mjs',
  'electron/tests/run-recovery.test.mjs',
  'electron/tests/workspace-paths.test.mjs',
]);
run('Python compile', python, ['-m', 'py_compile', 'science_agent/bridge.py', 'science_agent/daemon.py', 'science_agent/research_runtime.py', 'science_agent/citation_audit.py']);
run('Python unit tests', python, ['-m', 'unittest', 'discover', '-s', 'science_agent/tests', '-v']);
run('Harness research profile', python, ['scripts/profile_check.py']);
