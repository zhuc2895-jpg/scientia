const { contextBridge, ipcRenderer, webUtils } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('scienceAgent', {
  configLoad: () => ipcRenderer.invoke('config:load'),
  configSave: (payload) => ipcRenderer.invoke('config:save', payload),
  setApiKey: () => ipcRenderer.invoke('secret:set-api-key'),
  clearApiKey: () => ipcRenderer.invoke('secret:clear-api-key'),
  productStateLoad: () => ipcRenderer.invoke('product:load'),
  productStateMigrate: (payload) => ipcRenderer.invoke('product:migrate', payload),
  conversationCreate: (conversation) => ipcRenderer.invoke('conversation:create', conversation),
  conversationUpdate: (conversation) => ipcRenderer.invoke('conversation:update', conversation),
  conversationDelete: (id) => ipcRenderer.invoke('conversation:delete', id),
  conversationSetActive: (id) => ipcRenderer.invoke('conversation:set-active', id),
  flushProductState: (payload) => ipcRenderer.sendSync('product:flush', payload),
  pickWorkspace: () => ipcRenderer.invoke('workspace:pick'),
  inspectWorkspace: () => ipcRenderer.invoke('workspace:inspect'),
  openWorkspace: () => ipcRenderer.invoke('workspace:open'),
  openPath: (relativePath) => ipcRenderer.invoke('path:open', { relativePath }),
  revealPath: (relativePath) => ipcRenderer.invoke('path:reveal', { relativePath }),
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  importFiles: (paths) => ipcRenderer.invoke('files:import', { paths }),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  runAgent: (payload) => ipcRenderer.invoke('agent:run', payload),
  cancelAgent: (runId) => ipcRenderer.invoke('agent:cancel', runId),
  recoverRun: (payload) => ipcRenderer.invoke('research:recover-run', payload),
  onAgentEvent: (callback) => subscribe('agent:event', callback),
  runtime: () => ipcRenderer.invoke('app:runtime'),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  openData: () => ipcRenderer.invoke('app:open-data'),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  windowControl: (action) => ipcRenderer.invoke('window:control', action),
});
