import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createAppLifecycle } from '../app-lifecycle.js';

function fakeWindow() {
  return Object.assign(new EventEmitter(), { hidden: 0, hide() { this.hidden += 1; } });
}

test('closing the main window hides it without quitting the application', () => {
  let quitCalls = 0;
  const lifecycle = createAppLifecycle({
    app: { quit() { quitCalls += 1; } },
    getWindow: () => null,
    stopRuntime: async () => {},
  });
  const window = fakeWindow();
  let prevented = false;
  lifecycle.attachWindow(window);

  window.emit('close', { preventDefault() { prevented = true; } });

  assert.equal(prevented, true);
  assert.equal(window.hidden, 1);
  assert.equal(quitCalls, 0);
});

test('explicit quit waits for the runtime to stop before quitting again', async () => {
  let quitCalls = 0;
  let stopCalls = 0;
  let finishStop;
  const stopRuntime = () => {
    stopCalls += 1;
    return new Promise((resolve) => { finishStop = resolve; });
  };
  const lifecycle = createAppLifecycle({
    app: { quit() { quitCalls += 1; } },
    getWindow: () => null,
    stopRuntime,
  });

  lifecycle.requestQuit();
  let prevented = false;
  const stopping = lifecycle.handleBeforeQuit({ preventDefault() { prevented = true; } });
  await Promise.resolve();

  assert.equal(prevented, true);
  assert.equal(stopCalls, 1);
  assert.equal(quitCalls, 1);

  finishStop();
  await stopping;
  assert.equal(quitCalls, 2);
});
