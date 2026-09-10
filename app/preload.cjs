'use strict';
/*
 * preload.cjs — minimal API surface exposed to the sandboxed renderer.
 * Only getConfig / listHistory / ask / onStream (with unsubscribe).
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fairyApp', {
  getConfig: () => ipcRenderer.invoke('fairy:config'),
  /* The transcript lives in the main process (ADR-001); the renderer asks for it. */
  listHistory: (limit) => ipcRenderer.invoke('fairy:history', { limit }),
  /* One user message, not a whole history. */
  ask: (text, id) => ipcRenderer.send('fairy:ask', { text, id }),
  onStream: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('fairy:stream', handler);
    return () => ipcRenderer.removeListener('fairy:stream', handler);
  },
});
