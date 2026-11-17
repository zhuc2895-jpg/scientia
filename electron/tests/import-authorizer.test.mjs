import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { createImportAuthorizer } from '../import-authorizer.js';

test('an import authorization can be consumed only once', () => {
  const authorizer = createImportAuthorizer({ now: () => 1_000 });
  const source = path.join(path.parse(process.cwd()).root, 'research', 'paper.pdf');

  const [token] = authorizer.authorize([source]);

  assert.equal(typeof token, 'string');
  assert.deepEqual(authorizer.consume([token]), [source]);
  assert.throws(() => authorizer.consume([token]), /无效或已过期/);
});

test('import authorization rejects forged and expired tokens', () => {
  let currentTime = 1_000;
  const authorizer = createImportAuthorizer({ now: () => currentTime, ttlMs: 500 });
  const source = path.join(path.parse(process.cwd()).root, 'research', 'paper.pdf');
  const [token] = authorizer.authorize([source]);

  assert.throws(() => authorizer.consume(['forged-token']), /无效或已过期/);
  currentTime = 1_500;
  assert.throws(() => authorizer.consume([token]), /无效或已过期/);
});
