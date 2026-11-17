import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { removeManagedProjectWorkspace } from '../project-workspace.js';

test('deleting an imported project never removes its external directory', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scientia-imported-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'external-research');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'paper.md'), 'keep me');

  const removed = await removeManagedProjectWorkspace({
    managedRoot: path.join(root, 'managed'),
    project: { workspacePath: workspace, workspaceKind: 'imported' },
  });

  assert.equal(removed, false);
  assert.equal(await readFile(path.join(workspace, 'paper.md'), 'utf8'), 'keep me');
});

test('deleting a managed project removes only a workspace inside the managed root', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scientia-managed-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const managedRoot = path.join(root, 'managed');
  const workspace = path.join(managedRoot, 'project-2');
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'draft.md'), 'managed');

  const removed = await removeManagedProjectWorkspace({
    managedRoot,
    project: { workspacePath: workspace, workspaceKind: 'managed' },
  });

  assert.equal(removed, true);
  await assert.rejects(readFile(path.join(workspace, 'draft.md'), 'utf8'), /ENOENT/);
});

test('managed project deletion rejects a path outside the managed root', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scientia-managed-outside-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const managedRoot = path.join(root, 'managed');
  const outside = path.join(root, 'outside');
  await mkdir(managedRoot);
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.md'), 'keep');

  await assert.rejects(removeManagedProjectWorkspace({
    managedRoot,
    project: { workspacePath: outside, workspaceKind: 'managed' },
  }), /受管理目录/);
  assert.equal(await readFile(path.join(outside, 'secret.md'), 'utf8'), 'keep');
});
