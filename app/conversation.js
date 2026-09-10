'use strict';
/*
 * conversation.js — the conversation flow, independent of Electron and of IPC.
 *
 * This is the piece ADR-001 describes as "the main process owns the truth": the renderer
 * sends one user message, this module persists it, assembles the prompt from the persona
 * plus the stored history, and persists the reply as it streams in.
 *
 * It is kept free of `require('electron')` on purpose so it can be exercised by plain
 * Node tests (see tests/conversation.test.cjs). main.js is a thin wrapper over it.
 */

const store = require('./store.js');

/* Mirrors the original renderer behaviour: inject one example pair only while the
 * conversation is short, as a voice cue rather than a permanent token cost. */
const EXAMPLE_HISTORY_LIMIT = 4;

/* How many stored messages to send as context. Counts messages, not turns. */
const CONTEXT_MESSAGE_LIMIT = 30;

function nowLine(now) {
  const d = now == null ? new Date() : new Date(now);
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const days = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  return d.getFullYear() + '年' + pad(d.getMonth() + 1) + '月' + pad(d.getDate()) + '日 ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' ' + days[d.getDay()];
}

/* The user-profile block: what she is allowed to remember about the owner in v0.1.
 * Deliberately facts the app actually observed — no inferred personality claims. */
function profileLine(identity) {
  const lines = [];
  if (identity && identity.firstSeen) {
    const days = Math.floor((Date.now() - identity.firstSeen) / 86400000);
    const since = nowLine(identity.firstSeen).slice(0, 11);
    lines.push('- 你与主人首次见面于 ' + since + (days > 0 ? '（第 ' + (days + 1) + ' 天）' : '（就是今天）'));
  }
  if (identity && typeof identity.turns === 'number' && identity.turns > 0) {
    lines.push('- 这是你们之间的第 ' + (identity.turns + 1) + ' 轮对话');
  }
  return lines.length ? '\n\n# 主人画像（核心记忆）\n' + lines.join('\n') : '';
}

/*
 * Build the full system prompt: persona, then the observed profile, then the current
 * time. Rebuilt every turn so "now" is always accurate.
 */
function buildSystemPrompt(persona, identity, now) {
  return String(persona) + profileLine(identity) + '\n\n# 当前时间\n' + nowLine(now);
}

/*
 * Examples are a VOICE REFERENCE, not history.
 *
 * The first version injected them as real user/assistant message pairs. That was a design
 * error: from the model's point of view those pairs ARE its own past turns, so it treated
 * a sample answer as something it had actually said. One sample answer mentions
 * "凌晨两点十七分", and the model later "corrected itself" for a sentence it had never
 * said — while ignoring the question it had been asked.
 *
 * They now live inside the system prompt, clearly labelled as samples that did not happen.
 * Cost is the same (the tokens go out either way) and the model can no longer mistake them
 * for conversation.
 */
function styleReferenceSection(examples, pickExample) {
  if (!examples || !examples.length) return '';
  const ex = pickExample ? pickExample(examples) : examples[0];
  if (!ex || ex.length !== 2) return '';
  return '\n\n# 语气样例（仅示范风格，不属于对话内容）\n' +
    '下面是虚构的语气参考，**从未真实发生过**。绝不要把它们当成自己说过的话，' +
    '也不要引用、更正或延续其中的内容。\n' +
    '【主人】' + ex[0] + '\n' +
    '【你】' + ex[1] + '\n' +
    '（样例结束。请只根据真实对话内容回答主人的当前问题。）';
}

/* Assemble the API message list: one system prompt, then the stored history.
 * Nothing else is inserted — see styleReferenceSection for why. */
function buildMessages(options) {
  const persona = options.persona;
  const examples = options.examples || [];
  const history = options.history || [];
  const identity = options.identity;
  const now = options.now;

  let system = buildSystemPrompt(persona, identity, now);
  if (history.length <= EXAMPLE_HISTORY_LIMIT) {
    system += styleReferenceSection(examples, options.pickExample);
  }

  const messages = [{ role: 'system', content: system }];
  for (const m of history) {
    /* Only roles the chat API accepts; 'error' rows exist for the transcript but are not
     * part of the model's context. */
    if (m.role === 'user' || m.role === 'assistant') {
      messages.push({ role: m.role, content: m.content });
    }
  }
  return messages;
}

/* ---------------------------------------------------------------- the conversation */

/*
 * openConversation({ dir, persona, examples, model, pickExample })
 *
 * Returns an object that owns one conversation. When the store cannot be opened (disk
 * full, corrupt file, read-only location) `available` is false and every write becomes a
 * no-op: the app keeps working, it just does not remember. That degradation is required
 * by ADR-003, because a packaged build may land somewhere unwritable.
 */
function openConversation(options) {
  const opts = options || {};
  let s = null;
  let openError = null;

  try {
    s = store.open(opts.dir ? { dir: opts.dir } : {});
  } catch (err) {
    openError = err;
    s = null;
  }

  const available = s !== null;
  let turnSeq = 0;
  let currentTurn = null;   /* { userMessageId, assistantMessageId, turnId } */

  function identity() {
    if (!available) return null;
    const turns = Number(store.metaGet(s.db, 'turns') || 0);
    return {
      firstSeen: Number(store.metaGet(s.db, 'first_seen') || 0),
      turns: turns,
      lastSeen: Number(store.metaGet(s.db, 'last_seen') || 0) || null,
    };
  }

  function recentHistory(limit) {
    if (!available) return [];
    return store.recentMessages(s.db, limit == null ? CONTEXT_MESSAGE_LIMIT : limit);
  }

  /* Persist a user message and open a turn. Returns the turn handle used by the stream. */
  function beginTurn(text) {
    const content = String(text == null ? '' : text);
    const turnId = 't' + (++turnSeq) + '-' + store.newId();
    const result = { turnId, userMessageId: null, assistantMessageId: null, historyBefore: [] };

    if (!available) return result;

    /* History as it was *before* this message, so the prompt does not contain the user
     * turn twice (once from the store, once from the caller). */
    result.historyBefore = store.recentMessages(s.db, CONTEXT_MESSAGE_LIMIT);

    const userRow = store.appendMessage(s.db, { role: 'user', content, turnId });
    result.userMessageId = userRow.id;
    return result;
  }

  /* The messages to send to the API for an open turn. Remembered on the turn so the
   * diagnostics written alongside the reply reflect what was actually sent. */
  function messagesFor(turn) {
    const messages = buildMessages({
      persona: opts.persona,
      examples: opts.examples,
      identity: identity(),
      history: (turn && turn.historyBefore) || [],
      pickExample: opts.pickExample,
      now: Date.now(),
    });
    if (turn) {
      turn.contextMessages = messages.length;
      turn.promptChars = messages[0] && messages[0].content ? messages[0].content.length : 0;
    }
    return messages;
  }

  /* Persist the assistant reply. Called repeatedly while streaming: the row is created on
   * the first call and updated in place afterwards, so an interrupted stream still leaves
   * whatever text was received rather than nothing. */
  function recordAssistantDelta(turn, content, reasoning) {
    if (!available || !turn) return null;
    const diagnostics = {
      contextMessages: turn.contextMessages == null ? null : turn.contextMessages,
      promptChars: turn.promptChars == null ? null : turn.promptChars,
    };
    if (!turn.assistantMessageId) {
      const row = store.appendMessage(s.db, Object.assign({
        role: 'assistant',
        content: content == null ? '' : content,
        reasoning: reasoning == null ? null : reasoning,
        turnId: turn.turnId,
        model: opts.model || null,
      }, diagnostics));
      turn.assistantMessageId = row.id;
      return row.id;
    }
    store.updateMessage(s.db, turn.assistantMessageId, Object.assign({
      content: content == null ? '' : content,
      reasoning: reasoning == null ? null : reasoning,
    }, diagnostics));
    return turn.assistantMessageId;
  }

  /* Close the turn: finalise the reply text and count it. */
  function finishTurn(turn, finalContent, finalReasoning) {
    if (!available || !turn) return;
    if (finalContent != null || finalReasoning != null) {
      recordAssistantDelta(turn, finalContent, finalReasoning);
    }
    store.bumpTurns(s.db, 1);
    currentTurn = null;
  }

  /* Persist a failure as an 'error' row so the transcript reflects what happened. It is
   * excluded from the API context by buildMessages. */
  function recordError(turn, message) {
    if (!available) return;
    store.appendMessage(s.db, {
      role: 'error',
      content: String(message == null ? '' : message),
      turnId: turn ? turn.turnId : null,
    });
  }

  function close() {
    if (available) store.close(s);
  }

  return {
    available,
    openError,
    file: available ? s.file : null,
    dir: available ? s.dir : null,
    schemaVersion: available ? s.schemaVersion : null,
    identity,
    recentHistory,
    beginTurn,
    messagesFor,
    recordAssistantDelta,
    finishTurn,
    recordError,
    close,
    /* exposed for tests and diagnostics */
    _store: s,
  };
}

module.exports = {
  openConversation,
  buildMessages,
  buildSystemPrompt,
  profileLine,
  nowLine,
  EXAMPLE_HISTORY_LIMIT,
  CONTEXT_MESSAGE_LIMIT,
};
