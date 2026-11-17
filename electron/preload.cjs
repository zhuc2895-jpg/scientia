const { contextBridge, ipcRenderer, webUtils } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('scienceAgent', {
  configLoad: () => ipcRenderer.invoke('config:load'),
  configSave: (payload) => ipcRenderer.invoke('config:save', payload),
  productStateLoad: () => ipcRenderer.invoke('product:load'),
  productStateMigrate: (payload) => ipcRenderer.invoke('product:migrate', payload),
  conversationCreate: (conversation) => ipcRenderer.invoke('conversation:create', conversation),
  conversationUpdate: (conversation) => ipcRenderer.invoke('conversation:update', conversation),
  conversationDelete: (id) => ipcRenderer.invoke('conversation:delete', id),
  conversationSetActive: (id) => ipcRenderer.invoke('conversation:set-active', id),
  flushProductState: (payload) => ipcRenderer.sendSync('product:flush', payload),
  pickWorkspace: () => ipcRenderer.invoke('workspace:pick'),
  inspectWorkspace: (workspace) => ipcRenderer.invoke('workspace:inspect', workspace),
  openWorkspace: (workspace) => ipcRenderer.invoke('workspace:open', workspace),
  openPath: (workspace, relativePath) => ipcRenderer.invoke('path:open', { workspace, relativePath }),
  revealPath: (workspace, relativePath) => ipcRenderer.invoke('path:reveal', { workspace, relativePath }),
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  importFiles: (workspace, paths) => ipcRenderer.invoke('files:import', { workspace, paths }),
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
