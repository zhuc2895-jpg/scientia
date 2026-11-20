import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { installSourceRevision, stageSourceRevision } from '../source-revision.js';

test('remote revisions stay staged until explicitly installed', async (t) => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'scientia-source-revision-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  mkdirSync(path.join(workspace, '.science', 'sources'), { recursive: true });
  const localLocator = '.science/sources/paper.html';
  const sourcePath = path.join(workspace, localLocator);
  writeFileSync(sourcePath, 'Original source', 'utf8');
  const revised = Buffer.from('Revised source', 'utf8');
  const contentHash = createHash('sha256').update(revised).digest('hex');

  const staged = await stageSourceRevision({
    workspacePath: workspace,
    sourceId: 'source-1',
    bytes: revised,
  });
  assert.equal(staged.observedContentHash, contentHash);
  assert.equal(readFileSync(sourcePath, 'utf8'), 'Original source');

  const installation = await installSourceRevision({
    workspacePath: workspace,
    source: { localLocator },
    stagedLocator: staged.stagedLocator,
    expectedContentHash: contentHash,
  });
  assert.equal(readFileSync(sourcePath, 'utf8'), 'Revised source');
  await installation.rollback();
  assert.equal(readFileSync(sourcePath, 'utf8'), 'Original source');
});
