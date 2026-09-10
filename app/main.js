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
const conversation = require('./conversation.js');
const personality = require('./personality.js');

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

/*
 * The conversation — this process owns the truth (docs/ADR.md ADR-001): it stores the
 * messages, assembles the prompt and persists the reply. The renderer only sends text.
 *
 * If the store cannot be opened the app still runs; it just does not remember anything
 * (ADR-003).
 */
let conv = null;
function openConversation() {
  conv = conversation.openConversation({
    persona: personality.PERSONA,
    examples: personality.EXAMPLES,
    model: config.model,
    pickExample: (pool) => pool[Math.floor(Math.random() * pool.length)],
  });
  if (conv.available) {
    console.log('store: ' + conv.file + ' (schema v' + conv.schemaVersion + ')');
  } else {
    console.error('store unavailable, conversation will not be saved: ' +
      (conv.openError && conv.openError.message));
  }
}

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

/* The renderer asks for the transcript on startup so it can repaint after a restart.
 * Returns [] when the store is unavailable, so the renderer needs no special case. */
ipcMain.handle('fairy:history', (_event, payload) => {
  if (!conv) return [];
  const limit = payload && payload.limit;
  return conv.recentHistory(limit == null ? 60 : limit);
});

/* IPC: streaming chat. The payload is one user message, not a whole history: the main
 * process owns the transcript (ADR-001). */
ipcMain.on('fairy:ask', async (event, payload) => {
  const sender = event.sender;
  const emit = (ev) => {
    if (!sender.isDestroyed()) sender.send('fairy:stream', ev);
  };

  const text = String((payload && payload.text) || '').trim();
  const id = (payload && payload.id) || 'x';

  if (!conv) {
    emit({ type: 'error', id, message: 'Conversation store unavailable' });
    return;
  }
  if (!config.apiKey) {
    emit({ type: 'error', id, message: 'No API key configured (app/config.json or DEEPSEEK_API_KEY)' });
    return;
  }
  if (!text) {
    emit({ type: 'error', id, message: 'Empty message' });
    return;
  }

  /* The turn id comes from the store so a persisted turn and its stream events share one
   * identifier; the renderer's own counter is kept only to ignore stale events. */
  const turn = conv.beginTurn(text);
  const messages = conv.messagesFor(turn);

  /* Logged because a reply that ignores the question is usually a context problem, and the
   * count is the fastest way to tell "no history" apart from "history present". It is also
   * written to the store with the reply, so a past turn can be diagnosed later. */
  console.log('turn ' + id + ': sending ' + messages.length + ' message(s), system prompt ' +
    (messages[0].content ? messages[0].content.length : 0) + ' chars');

  let content = '';
  let reasoning = '';

  try {
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
      const detail = res ? await res.text().catch(() => '') : '';
      const message = 'HTTP ' + (res ? res.status : '?') + ' ' + detail.slice(0, 240);
      conv.recordError(turn, message);
      emit({ type: 'error', id, message });
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
      conv.finishTurn(turn, msg.content || '', msg.reasoning_content || '');
      emit({ type: 'done', id });
      return;
    }

    /* SSE stream. */
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
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
          conv.recordAssistantDelta(turn, content, reasoning);
          emit({ type: 'reasoning', id, text: delta.reasoning_content });
        }
        if (delta.content) {
          content += delta.content;
          conv.recordAssistantDelta(turn, content, reasoning);
          emit({ type: 'content', id, text: delta.content });
        }
      }
    }
    conv.finishTurn(turn, content, reasoning);
    emit({ type: 'done', id });
  } catch (err) {
    const name = (err && err.name) || '';
    const msg = name === 'AbortError' ? 'Request timed out' : String((err && err.message) || err);
    /* Keep whatever the model already produced: an interrupted reply is still part of the
     * transcript, and the failure itself is recorded so the log is honest. */
    conv.finishTurn(turn, content, reasoning);
    conv.recordError(turn, msg);
    emit({ type: 'error', id, message: msg });
  }
});

app.whenReady().then(() => {
  openConversation();
  createWindow();
});
app.on('window-all-closed', () => {
  if (conv) conv.close();
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
