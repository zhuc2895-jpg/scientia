import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createConfigStore } from '../config-store.js';

function temporaryConfig(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'scientia-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'science-agent.json');
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

test('a missing config file resolves to defaults', async (t) => {
  const store = createConfigStore({ filePath: temporaryConfig(t), defaults: () => ({ model: 'default' }) });

  assert.deepEqual(await store.read(), { model: 'default' });
});

test('a corrupt config file is reported instead of silently replaced', async (t) => {
  const filePath = temporaryConfig(t);
  writeFileSync(filePath, '{ not json', 'utf8');
  const store = createConfigStore({ filePath, defaults: () => ({ model: 'default' }) });

  await assert.rejects(store.read(), /配置文件/);
  await assert.rejects(store.update((config) => ({ ...config, model: 'new' })), /配置文件/);
  assert.equal(readFileSync(filePath, 'utf8'), '{ not json');
});

test('concurrent config updates keep every mutation', async (t) => {
  const store = createConfigStore({ filePath: temporaryConfig(t), defaults: () => ({ base: true }) });

  await Promise.all([
    store.update(async (config) => {
      await tick();
      return { ...config, alpha: 1 };
    }),
    store.update(async (config) => {
      await tick();
      return { ...config, beta: 2 };
    }),
  ]);

  assert.deepEqual(await store.read(), { base: true, alpha: 1, beta: 2 });
});

test('an invalid config can be explicitly reset from default values', async (t) => {
  const filePath = temporaryConfig(t);
  writeFileSync(filePath, '{ not json', 'utf8');
  const store = createConfigStore({ filePath, defaults: () => ({ model: 'default' }) });

  const saved = await store.updateOrReset((config) => ({ ...config, workspace: 'C:/Research/Recovered' }));

  assert.deepEqual(saved, { model: 'default', workspace: 'C:/Research/Recovered' });
  assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), saved);
});
