'use strict';
/*
 * main.js — Electron main process.
 * Proxies streaming (SSE) chat to the model over IPC so the API key never leaves
 * the main process; the renderer stays sandboxed with no network access.
 * Stream signals: reasoning_content -> thinking, content -> speaking.
 */
const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

/* Config: environment variables win over config.json. */
const config = { apiKey: '', model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com' };
function loadConfig() {
  try {
    const p = path.join(__dirname, 'config.json');
    if (fs.existsSync(p)) Object.assign(config, JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch (_) { /* ignore malformed config */ }
  config.apiKey = process.env.DEEPSEEK_API_KEY || config.apiKey || '';
  config.model = process.env.DEEPSEEK_MODEL || config.model || 'deepseek-v4-flash';
}
loadConfig();

app.setName('HDD');

function createWindow() {
  const win = new BrowserWindow({
    width: 1120,
    height: 800,
    minWidth: 760,
    minHeight: 560,
    title: 'HDD',
    backgroundColor: '#07101c',
    autoHideMenuBar: true,
    show: false,
    fullscreen: true, /* Esc closes the window (see before-input-event below) */
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  win.loadFile(path.join(__dirname, 'www', 'live.html'));
  win.once('ready-to-show', () => win.show());

  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') win.close();
  });
}

Menu.setApplicationMenu(null);

ipcMain.handle('fairy:config', () => ({
  configured: Boolean(config.apiKey),
  model: config.model,
  baseUrl: config.baseUrl,
}));

/* IPC: streaming chat. */
ipcMain.on('fairy:ask', async (event, payload) => {
  const sender = event.sender;
  const emit = (ev) => {
    if (!sender.isDestroyed()) sender.send('fairy:stream', ev);
  };
  const id = (payload && payload.id) || 'x';
  const messages = Array.isArray(payload && payload.messages) ? payload.messages : [];

  try {
    if (!config.apiKey) {
      emit({ type: 'error', id, message: 'No API key configured (app/config.json or DEEPSEEK_API_KEY)' });
      return;
    }
    if (messages.length === 0) {
      emit({ type: 'error', id, message: 'Empty message' });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180000);
    let res;
    try {
      res = await fetch(config.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + config.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          stream: true,
          max_tokens: 4096,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res || !res.ok || !res.body) {
      const text = res ? await res.text().catch(() => '') : '';
      emit({ type: 'error', id, message: 'HTTP ' + (res ? res.status : '?') + ' ' + text.slice(0, 240) });
      return;
    }

    const ct = (res.headers.get('content-type') || '').toLowerCase();

    /* Fallback for a non-streaming response; should not happen with stream:true. */
    if (!ct.includes('text/event-stream') && !ct.includes('ndjson')) {
      const full = await res.text();
      const j = JSON.parse(full);
      const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
      if (msg.reasoning_content) emit({ type: 'reasoning', id, text: msg.reasoning_content });
      if (msg.content) emit({ type: 'content', id, text: msg.content });
      emit({ type: 'done', id });
      return;
    }

    /* SSE stream. */
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let reasoning = '';
    let content = '';
    let finished = false;

    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') { finished = true; break; }
        let j;
        try { j = JSON.parse(data); } catch (_) { continue; }
        const delta = (j.choices && j.choices[0] && j.choices[0].delta) || {};
        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          emit({ type: 'reasoning', id, text: delta.reasoning_content });
        }
        if (delta.content) {
          content += delta.content;
          emit({ type: 'content', id, text: delta.content });
        }
      }
    }
    emit({ type: 'done', id });
  } catch (err) {
    const name = (err && err.name) || '';
    const msg = name === 'AbortError' ? 'Request timed out' : String((err && err.message) || err);
    emit({ type: 'error', id, message: msg });
  }
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
