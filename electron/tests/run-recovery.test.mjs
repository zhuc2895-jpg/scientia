import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readRunManifest } from '../run-recovery.js';

test('run recovery reads the manifest for the matching conversation and run', async (t) => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'scientia-run-recovery-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const runDirectory = path.join(workspace, '.science', 'runs', 'conversation-1', 'run-1');
  mkdirSync(runDirectory, { recursive: true });
  const manifest = {
    runId: 'run-1',
    conversationId: 'conversation-1',
    status: 'running',
    startedAt: '2026-11-17T00:00:00.000Z',
  };
  writeFileSync(path.join(runDirectory, 'manifest.json'), JSON.stringify(manifest), 'utf8');

  const recovered = await readRunManifest({ workspace, conversationId: 'conversation-1', runId: 'run-1' });

  assert.deepEqual(recovered.manifest, manifest);
  assert.equal(recovered.manifestPath, '.science/runs/conversation-1/run-1/manifest.json');
});
