export function createAppLifecycle({ app, getWindow, stopRuntime }) {
  let quitting = false;
  let readyToQuit = false;
  let stopPromise = null;

  function attachWindow(window) {
    window.on('close', (event) => {
      if (quitting) return;
      event.preventDefault();
      window.hide();
    });
  }

  function requestQuit() {
    quitting = true;
    app.quit();
  }

  function handleBeforeQuit(event) {
    if (readyToQuit) return null;
    quitting = true;
    event.preventDefault();
    if (!stopPromise) {
      stopPromise = Promise.resolve()
        .then(() => stopRuntime())
        .finally(() => {
          readyToQuit = true;
          app.quit();
        });
    }
    return stopPromise;
  }

  return {
    attachWindow,
    requestQuit,
    handleBeforeQuit,
  };
}
