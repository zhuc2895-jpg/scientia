import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveWorkspaceEntry } from '../workspace-paths.js';

test('workspace path resolution rejects a link that escapes the project workspace', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scientia-workspace-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'outside');
  await symlink(outside, path.join(workspace, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');

  await assert.rejects(
    resolveWorkspaceEntry(workspace, 'outside-link/secret.txt'),
    /文件不在当前研究目录中/,
  );
});

test('workspace path resolution accepts files inside the project workspace', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scientia-workspace-paths-inside-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'paper.md'), 'inside');

  assert.equal(await resolveWorkspaceEntry(root, 'paper.md'), path.join(root, 'paper.md'));
});
