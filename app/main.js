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
 * Ask the model whether the message really opens a new subject (ADR-012, revision 1).
 *
 * The local rule in topics.js only proposes; this decides. It exists because the first real
 * transcript showed that lexical overlap cannot tell a subject continued in different words
 * from a subject that actually changed — both scored zero — and acting on that guess made her
 * answer about herself instead of about the project she was asked about.
 *
 * Every failure returns null, which the conversation reads as "stay where you are". A
 * classifier that is unreachable must not be able to invent topic boundaries: silence has to
 * mean "no", so that a missing key or a dead network degrades to one topic per sitting rather
 * than to splits nobody asked for.
 *
 * The request is small and non-streaming, and it is only made when the local rule proposes a
 * boundary — typically a message that shares no vocabulary with the current subject.
 */
const CONFIRM_TIMEOUT_MS = 8000;

async function confirmBoundary(input) {
  if (!config.apiKey) return null;
  const recent = (input.recent || []).slice(-6);
  const transcript = recent
    .map((m) => (m.role === 'user' ? '主人：' : '你：') + m.content)
    .join('\n');

  const system = [
    '你是话题切分器。判断主人这条新消息是否仍在延续当前话题。',
    '只输出一个 JSON 对象，不要输出解释、不要加代码块。',
    '格式：{"same": true|false, "title": "..."}',
    'same 为 true 表示延续当前话题，此时 title 填空字符串。',
    'same 为 false 表示换了新话题，此时 title 给出新话题的名字：4 到 12 个字的名词短语，',
    '概括主题（例如「终端项目的全文搜索」「科幻电影推荐」），不要照抄原句、不要带标点。',
    '判断标准：即使在讨论同一个项目的不同方面，只要仍在谈同一件事，就算 same。',
  ].join('\n');

  const user = '当前话题：' + input.topic.title + '\n' +
    (transcript ? '最近的对话：\n' + transcript + '\n' : '') +
    '新消息：' + input.text;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIRM_TIMEOUT_MS);
  try {
    const res = await fetch(config.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + config.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        stream: false,
        max_tokens: 80,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    if (!res || !res.ok) return null;
    const data = await res.json();
    const text = (data.choices && data.choices[0] && data.choices[0].message &&
      data.choices[0].message.content) || '';
    return parseBoundaryVerdict(text);
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/*
 * Read the verdict out of whatever came back. Models wrap JSON in prose or code fences, and a
 * classifier that fails to parse is the same as one that was never asked, so this returns null
 * rather than guessing a default.
 */
function parseBoundaryVerdict(text) {
  const s = String(text == null ? '' : text);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(s.slice(start, end + 1));
  } catch (_) {
    return null;
  }
  if (!parsed || typeof parsed.same !== 'boolean') return null;
  return {
    isNew: !parsed.same,
    title: typeof parsed.title === 'string' ? parsed.title.trim() : '',
  };
}

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
    /* A boundary is only opened when this agrees. See confirmBoundary above. */
    confirmBoundary,
    onConfirmError: (err) => {
      console.error('topic confirmation failed, staying in the current topic: ' +
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
