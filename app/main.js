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
const api = require('./api.js');

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
 * The two side requests — deciding a topic boundary and extracting memories — live in api.js,
 * because they need a key and a network rather than an Electron app, and a module main.js cannot
 * load was the reason neither of them could ever be tested without opening a window.
 */
const model = api.createApi(config);

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
    /* A boundary is only opened when this agrees. See api.js. */
    confirmBoundary: model.confirmBoundary,
    onConfirmError: (err) => {
      console.error('topic confirmation failed, staying in the current topic: ' +
        String((err && err.message) || err));
    },
    /* Memories are only extracted when memory.js says the turn is worth a request. */
    extractMemories: model.extractMemories,
    onMemoryError: (err) => {
      console.error('memory extraction failed, nothing was remembered: ' +
        String((err && err.message) || err));
    },
  });
  if (conv.available) {
    console.log('store: ' + conv.file + ' (schema v' + conv.schemaVersion + ')');
  } else {
    console.error('store unavailable, conversation will not be saved: ' +
      (conv.openError && conv.openError.message));
  }
}

/*
 * Remember a finished turn, and report what happened.
 *
 * Called after the reply has been sent to the renderer: this is a second request, and nothing the
 * user is waiting for should queue behind it. The line it logs is the only place the trigger's
 * decision is visible — "skipped (cooldown)" and "asked (correction) -> stored 1" are the same
 * silence in the transcript.
 */
async function rememberAfter(turn) {
  if (!conv) return;
  const result = await conv.rememberTurn(turn);
  console.log('  memory: ' + (result.asked
    ? 'asked (' + result.reason + ') -> stored ' + result.stored + ', superseded ' + result.superseded +
      (result.error ? ' (failed: ' + result.error.message + ')' : '')
    : 'skipped (' + result.reason + ')'));
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

/* The renderer asks for the transcript on startup so it can repaint after a restart, and
 * again after a topic switch. One topic at a time: `topicId` defaults to the topic that was
 * in progress (ADR-001, ADR-012). Returns [] when the store is unavailable, so the renderer
 * needs no special case. */
ipcMain.handle('fairy:history', (_event, payload) => {
  if (!conv) return [];
  const p = payload || {};
  return conv.listHistory({
    topicId: p.topicId || null,
    limit: p.limit == null ? 60 : p.limit,
  });
});

/* The topic list plus which one is active. Every mutation below returns this same shape, so
 * the renderer never has to guess what changed or issue a second round trip to find out. */
function topicState() {
  const current = conv ? conv.activeTopic() : null;
  return {
    currentId: current ? current.id : null,
    currentTitle: current ? current.title : null,
    topics: conv ? conv.listTopics() : [],
  };
}

ipcMain.handle('fairy:topics', () => topicState());

ipcMain.handle('fairy:topic-new', (_event, payload) => {
  if (conv) conv.newTopic(payload && payload.title);
  return topicState();
});

ipcMain.handle('fairy:topic-switch', (_event, payload) => {
  const id = payload && payload.id;
  if (conv && id) conv.switchTopic(id);
  return topicState();
});

ipcMain.handle('fairy:topic-rename', (_event, payload) => {
  const p = payload || {};
  if (conv && (p.id || conv.activeTopic())) conv.renameTopic(p.id, p.title);
  return topicState();
});

/* Full-text search across every topic by default (ADR-002: this is FTS5, not the semantic
 * retrieval that ADR-007 defers to Phase 5). */
ipcMain.handle('fairy:search', (_event, payload) => {
  if (!conv) return [];
  const p = payload || {};
  return conv.search(p.query, { limit: p.limit, topicId: p.topicId });
});

/* Memories. A wrong memory is worse than no memory, so the owner can read and remove theirs
 * (ADR-013); these three channels are the whole of that surface. `sourceCount` comes with each row
 * because provenance that cannot be seen cannot be argued with. */
ipcMain.handle('fairy:memories', () => {
  if (!conv) return { memories: [], superseded: 0 };
  const memories = conv.memories();
  const all = conv.memories({ includeSuperseded: true });
  return { memories, superseded: Math.max(0, all.length - memories.length) };
});

ipcMain.handle('fairy:memory-remember', (_event, payload) => {
  if (!conv) return { memories: [], superseded: 0, stored: false };
  const stored = Boolean(conv.remember(payload && payload.text));
  const memories = conv.memories();
  const all = conv.memories({ includeSuperseded: true });
  return { memories, superseded: Math.max(0, all.length - memories.length), stored };
});

ipcMain.handle('fairy:memory-forget', (_event, payload) => {
  if (!conv) return { memories: [], superseded: 0, removed: 0 };
  const id = payload && payload.id;
  const removed = id ? conv.forgetMemory(id) : 0;
  const memories = conv.memories();
  const all = conv.memories({ includeSuperseded: true });
  return { memories, superseded: Math.max(0, all.length - memories.length), removed };
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
   * identifier; the renderer's own counter is kept only to ignore stale events.
   * beginTurn is async because a topic boundary may need the classifier above. */
  const turn = await conv.beginTurn(text);
  const messages = conv.messagesFor(turn);

  /* Which topic this went into, and whether a confirmation backed that up. A boundary that
   * nobody asked for, and one that was asked for and refused, look identical in the
   * transcript and quite different here. */
  console.log('turn ' + id + ': topic ' + (turn.topicReason || '?') +
    (turn.topicConfirmed === null ? ' (not proposed)' :
      (turn.topicConfirmed ? ' (confirmed: new topic)' : ' (confirmed: kept)')) +
    ' -> ' + (turn.topicId || 'none'));

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
      await rememberAfter(turn);
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
    await rememberAfter(turn);
  } catch (err) {
    const name = (err && err.name) || '';
    const msg = name === 'AbortError' ? 'Request timed out' : String((err && err.message) || err);
    /* Keep whatever the model already produced: an interrupted reply is still part of the
     * transcript, and the failure itself is recorded so the log is honest. */
    conv.finishTurn(turn, content, reasoning);
    conv.recordError(turn, msg);
    emit({ type: 'error', id, message: msg });
    /* Still worth remembering: the failure was in the reply, not in what the owner said, and a
     * fact stated during a turn that failed is exactly the kind that never gets repeated. */
    await rememberAfter(turn);
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
