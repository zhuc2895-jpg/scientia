import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { captureSecretFromUser } from '../native-secret-input.js';

test('native secret capture returns the secret through the main-process adapter', async () => {
  let invocation = null;
  const spawnProcess = (command, args, options) => {
    invocation = { command, args, options };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.emit('data', 'sk-native-secret\r\n');
      child.emit('close', 0);
    });
    return child;
  };

  const secret = await captureSecretFromUser({ platform: 'win32', spawnProcess });

  assert.equal(secret, 'sk-native-secret');
  assert.equal(invocation.command, 'powershell.exe');
  assert.ok(invocation.args.includes('-STA'));
  assert.equal(invocation.options.windowsHide, true);
});
