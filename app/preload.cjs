'use strict';
/*
 * preload.cjs — minimal API surface exposed to the sandboxed renderer.
 * Conversation: getConfig / listHistory / ask / onStream (with unsubscribe).
 * Topics: listTopics / newTopic / switchTopic / renameTopic / search.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fairyApp', {
  getConfig: () => ipcRenderer.invoke('fairy:config'),
  /* The transcript lives in the main process (ADR-001); the renderer asks for one topic. */
  listHistory: (options) => ipcRenderer.invoke('fairy:history', options || {}),
  /* One user message, not a whole history. */
  ask: (text, id) => ipcRenderer.send('fairy:ask', { text, id }),
  onStream: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('fairy:stream', handler);
    return () => ipcRenderer.removeListener('fairy:stream', handler);
  },
  /* Topics are decided in the main process (ADR-012); these only read or override it. */
  listTopics: () => ipcRenderer.invoke('fairy:topics'),
  newTopic: (title) => ipcRenderer.invoke('fairy:topic-new', { title }),
  switchTopic: (id) => ipcRenderer.invoke('fairy:topic-switch', { id }),
  renameTopic: (id, title) => ipcRenderer.invoke('fairy:topic-rename', { id, title }),
  search: (query, options) => ipcRenderer.invoke('fairy:search', Object.assign({ query }, options || {})),
});
