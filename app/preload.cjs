'use strict';
/*
 * preload.cjs — minimal API surface exposed to the sandboxed renderer.
 * Only getConfig / ask / onStream (with unsubscribe).
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fairyApp', {
  getConfig: () => ipcRenderer.invoke('fairy:config'),
  ask: (messages, id) => ipcRenderer.send('fairy:ask', { messages, id }),
  onStream: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('fairy:stream', handler);
    return () => ipcRenderer.removeListener('fairy:stream', handler);
  },
});
