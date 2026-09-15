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
const capabilities = require('./capabilities.js');
const topics = require('./topics.js');
const memory = require('./memory.js');

/* Mirrors the original renderer behaviour: inject one example pair only while the
 * conversation is short, as a voice cue rather than a permanent token cost. */
const EXAMPLE_HISTORY_LIMIT = 4;

/* How many stored messages to send as context. Counts messages, not turns. */
const CONTEXT_MESSAGE_LIMIT = 30;

/* How many existing memories the extractor is shown, so it can recognise an update instead of
 * adding a duplicate. Counts memories, and the section they render into is capped separately. */
const MEMORY_CONTEXT_LIMIT = 20;

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
 * The memories she currently believes, rendered beside the profile — both are facts about the
 * owner, so they belong in the same part of the prompt, before the time.
 *
 * Two ceilings, because one is not enough. The count keeps the section from growing without bound
 * as memories accumulate, and the character ceiling is what actually protects the prompt budget
 * ADR-008 warns about: a memory is a sentence, so counting them bounds the number of statements
 * rather than their size. Newest first, so a ceiling that bites drops the oldest beliefs — which
 * ones lose out is a question for `docs/eval`, not for this comment.
 */
const MEMORY_INJECT_LIMIT = 20;
const MEMORY_SECTION_MAX_CHARS = 1200;

function memorySection(memories) {
  const list = (memories || []).slice(0, MEMORY_INJECT_LIMIT);
  if (!list.length) return '';

  const lines = [];
  let used = 0;
  for (const m of list) {
    const text = String(m && m.text == null ? '' : m.text).trim();
    if (!text) continue;
    const line = '- ' + text;
    if (used + line.length > MEMORY_SECTION_MAX_CHARS) break;
    lines.push(line);
    used += line.length;
  }
  if (!lines.length) return '';

  return '\n\n# 关于主人的长期记忆\n' +
    '以下是你在之前的对话里了解到的关于主人的事。\n' + lines.join('\n');
}

/*
 * Build the full system prompt: persona, then what the program can actually do, then the
 * observed profile, then what she remembers about the owner, then the current time. Rebuilt
 * every turn so "now" is always accurate.
 *
 * Order matters at the top: the capability facts sit immediately after the persona because
 * they constrain what she may claim, and they must not be buried under flavour. See
 * capabilities.js for why they are not part of the persona.
 */
function buildSystemPrompt(persona, identity, now, memories) {
  return String(persona) + capabilities.capabilitySection() + profileLine(identity) +
    memorySection(memories) + '\n\n# 当前时间\n' + nowLine(now);
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

  let system = buildSystemPrompt(persona, identity, now, options.memories);
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
 * openConversation({ dir, persona, examples, model, pickExample, now })
 *
 * Returns an object that owns one conversation. When the store cannot be opened (disk
 * full, corrupt file, read-only location) `available` is false and every write becomes a
 * no-op: the app keeps working, it just does not remember. That degradation is required
 * by ADR-003, because a packaged build may land somewhere unwritable.
 *
 * `now` is an injectable clock. Topic boundaries depend on how long the conversation has
 * been idle (ADR-012), and a test that has to wait six hours to exercise that is a test
 * nobody runs.
 */
function openConversation(options) {
  const opts = options || {};
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
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
    const topic = store.getCurrentTopic(s.db);
    return store.recentMessages(s.db, limit == null ? CONTEXT_MESSAGE_LIMIT : limit,
      topic ? { topicId: topic.id } : {});
  }

  /* The transcript to repaint: one topic's messages, oldest first. `topicId` defaults to the
   * active topic, which is what the renderer wants after a restart. */
  function listHistory(options) {
    const o = options || {};
    if (!available) return [];
    const topicId = o.topicId || (store.getCurrentTopic(s.db) || {}).id || null;
    return store.recentMessages(s.db, o.limit == null ? 60 : o.limit,
      topicId ? { topicId } : {});
  }

  /* ---------------------------------------------------------------- topics */

  function activeTopic() {
    if (!available) return null;
    return store.getCurrentTopic(s.db);
  }

  function listTopics() {
    if (!available) return [];
    return store.listTopics(s.db);
  }

  function switchTopic(id) {
    if (!available) return null;
    return store.setCurrentTopic(s.db, id);
  }

  /* Open a topic explicitly, whatever the detector would have said. This is the escape hatch
   * for the one mistake a lexical detector cannot avoid: continuing the same subject in
   * entirely different words reads as a change of subject (ADR-012). */
  function newTopic(title) {
    if (!available) return null;
    const clean = String(title == null ? '' : title).trim();
    const created = store.createTopic(s.db, {
      title: clean || topics.FALLBACK_TITLE,
      createdAt: now(),
    });
    store.setCurrentTopic(s.db, created.id);
    return created;
  }

  function renameTopic(id, title) {
    if (!available) return null;
    const current = store.getCurrentTopic(s.db);
    const target = id || (current ? current.id : null);
    if (!target) return null;
    return store.renameTopic(s.db, target, title);
  }

  function search(query, options) {
    const o = options || {};
    if (!available) return [];
    return store.searchMessages(s.db, query, o.limit, o.topicId ? { topicId: o.topicId } : {});
  }

  /*
   * A name from the confirmer, or null when it gave nothing usable. It is sanitised through the
   * same rules as a derived title, so a wrapped quotation mark or a runaway sentence cannot
   * reach the topic list, and it must carry at least one content term: a name made only of
   * punctuation ("…") is not a name. The placeholder is rejected rather than accepted — a topic
   * called 「未命名话题」 is worse than one named after the message that opened it.
   */
  function modelTitle(raw) {
    if (raw == null) return null;
    const clean = topics.titleFromText(raw);
    if (!clean || clean === topics.FALLBACK_TITLE) return null;
    return topics.contentTerms(clean).length ? clean : null;
  }

  /* Whether a message carries enough content to name a subject. Used both when a topic is
   * created and when a provisional title is replaced, so the two rules cannot drift: a message
   * that could not have named the topic in the first place must not rename it later either.
   * Without this a two-term laugh ("哈哈哈") became the permanent name of a topic, and because
   * naming locks the title it also blocked the greeting from being absorbed afterwards. */
  function couldNameTopic(text) {
    return topics.contentTerms(text).length >= topics.MIN_PROPOSAL_TERMS;
  }

  /*
   * Which topic the message being asked right now belongs to.
   *
   * Resolved BEFORE the message is stored, and deliberately so: the message has to be written
   * with its topic, and the history handed to the model has to be the history of that same
   * topic. Deciding afterwards would assemble the prompt from the previous subject while
   * filing the answer under the new one.
   *
   * Async because a boundary can require a request (ADR-012, revision 1). The local rule in
   * topics.js only proposes; `confirmBoundary` decides, and anything other than an explicit
   * "yes, new subject" keeps the message where it is. That includes a confirmation that threw,
   * timed out, or was never configured — so with no model available this degrades to "one topic
   * per sitting", which is the behaviour that cannot mislead her about what a sentence means.
   */
  async function resolveTopic(text) {
    const current = store.getCurrentTopic(s.db);
    if (!current) {
      const created = store.createTopic(s.db, {
        title: topics.titleFromText(text),
        createdAt: now(),
        /* A message too thin to name a subject leaves the title open, so the greeting a session
         * opens with does not become its permanent name. */
        titleLocked: couldNameTopic(text),
      });
      store.setCurrentTopic(s.db, created.id);
      return { topic: created, reason: 'first', confirmed: null };
    }

    /* An empty topic is waiting for its first message — whether /new just created it or a
     * restart restored it. Running the detector against an empty topic would judge the
     * message against no subject at all, score it as completely off-topic, and open a second
     * topic beside the empty one, so an explicit /new could never be used with a long message. */
    const lastAt = store.lastMessageAt(s.db, current.id);
    if (!lastAt) return { topic: current, reason: 'continue', confirmed: null };

    const proposal = topics.proposeBoundary({
      hasTopic: true,
      lastMessageAt: lastAt,
      now: now(),
      text,
      recentTexts: store.recentMessages(s.db, topics.RECENT_WINDOW_MESSAGES, { topicId: current.id })
        .map((m) => m.content),
    });

    if (proposal.propose) {
      const verdict = await askConfirmation(text, current);
      if (verdict && verdict.isNew) {
        const created = store.createTopic(s.db, {
          title: verdict.title || topics.titleFromText(text),
          createdAt: now(),
          titleLocked: true,
        });
        /* Carry over a topic that never earned a name (a greeting) instead of leaving a
         * nameless one behind for every sitting. */
        if (!current.titleLocked) store.absorbTopic(s.db, current.id, created.id);
        store.setCurrentTopic(s.db, created.id);
        return { topic: created, reason: proposal.reason, confirmed: true };
      }
      /* Not confirmed, or nothing could confirm it: stay, and name the topic if it is still
       * provisional — by the model when it answered, otherwise after the message that arrived.
       * No separate "substantial enough" test is needed here: a message only reaches this line
       * by having proposed, which already requires MIN_PROPOSAL_TERMS content terms.
       *
       * Naming on a "same" answer is what stops a session that opens with a greeting from
       * being titled after the truncated sentence that followed it: the confirmation request
       * happens anyway, so the name costs nothing extra. */
      if (!current.titleLocked) {
        store.retitleTopic(s.db, current.id, (verdict && verdict.title) || topics.titleFromText(text));
      }
      return {
        topic: store.getTopic(s.db, current.id) || current,
        reason: proposal.reason,
        confirmed: verdict ? false : null,
      };
    }

    if (!current.titleLocked && couldNameTopic(text)) {
      store.retitleTopic(s.db, current.id, topics.titleFromText(text));
    }
    return {
      topic: store.getTopic(s.db, current.id) || current,
      reason: proposal.reason,
      confirmed: null,
    };
  }

  /* Ask the injected confirmer, and never let it break a turn: a request that fails is the
   * same as one that was never made, which means "stay in this topic". */
  async function askConfirmation(text, topic) {
    const confirm = opts.confirmBoundary;
    if (typeof confirm !== 'function') return null;
    try {
      const verdict = await confirm({
        text,
        topic: { id: topic.id, title: topic.title },
        /* Role-tagged, and only the two roles that carry dialogue: labelling by position would
         * mislabel the transcript as soon as the window opened with an assistant or error row,
         * and the classifier is being asked about who said what. */
        recent: store.recentMessages(s.db, topics.RECENT_WINDOW_MESSAGES, { topicId: topic.id })
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({ role: m.role, content: m.content })),
      });
      if (!verdict || typeof verdict.isNew !== 'boolean') return null;
      return {
        isNew: verdict.isNew,
        title: modelTitle(verdict.title),
      };
    } catch (err) {
      /* Recorded, not swallowed silently: an unreachable classifier looks exactly like a
       * conversation that never changes subject. */
      if (opts.onConfirmError) opts.onConfirmError(err);
      return null;
    }
  }

  /* ---------------------------------------------------------------- memory */

  /*
   * Turns since the last extraction request in each topic, kept in memory only. Losing it on a
   * restart costs one extra request; persisting a counter whose whole job is to save a request is
   * not worth a schema change, and a schema change is not free (ADR-004).
   */
  const lastMemoryAsk = new Map();

  function turnsSinceMemoryAsk(topicId) {
    const last = lastMemoryAsk.get(topicId);
    return typeof last === 'number' ? turnSeq - last : null;
  }

  function memories(options) {
    if (!available) return [];
    return store.listMemories(s.db, options || {});
  }

  function activeMemoryList(limit) {
    if (!available) return [];
    return store.activeMemories(s.db, limit == null ? MEMORY_CONTEXT_LIMIT : limit);
  }

  function forgetMemory(id) {
    if (!available) return 0;
    return store.forgetMemory(s.db, id);
  }

  /* The owner stating a fact about themselves. Deliberately sourceless: it was not inferred from
   * any message, and attaching one would make the provenance say something untrue. */
  function remember(text) {
    if (!available) return null;
    const clean = String(text == null ? '' : text).trim();
    if (!clean) return null;
    return store.createMemory(s.db, { text: clean, origin: 'owner', createdAt: now() });
  }

  /*
   * Run the extractor for a turn that has already finished.
   *
   * Called after the reply is persisted and on its way to the screen, so this request never delays
   * anything the user is waiting for. Every path through it is best-effort: no trigger means no
   * request, no extractor means no memories, an unreadable answer means no memories, and a thrown
   * error is reported rather than raised. What it must never do is fail a turn that has already
   * succeeded.
   *
   * A memory's sources are the two messages of the turn — the owner's statement and the reply it
   * drew. Turn granularity, not sentence granularity: the extractor returns text, not offsets, and
   * inventing a finer link would claim a precision the data does not have.
   */
  async function rememberTurn(turn) {
    const result = { asked: false, reason: null, stored: 0, superseded: 0, error: null };
    if (!available || !turn || !turn.topicId) return result;

    const decision = memory.shouldExtract({
      text: turn.userText,
      turnsSinceAsk: turnsSinceMemoryAsk(turn.topicId),
    });
    result.reason = decision.reason;
    if (!decision.ask) return result;

    result.asked = true;
    /* Recorded before the request: whether it succeeds or fails, the cooldown has been spent, and a
     * failing extractor must not become a request on every single turn. */
    lastMemoryAsk.set(turn.topicId, turnSeq);

    const extract = opts.extractMemories;
    if (typeof extract !== 'function') return result;

    try {
      const existing = store.activeMemories(s.db, MEMORY_CONTEXT_LIMIT);
      const raw = await extract({
        userText: turn.userText,
        assistantText: turn.assistantText == null ? '' : turn.assistantText,
        existing: existing.map((m) => ({ id: m.id, text: m.text })),
      });
      const found = memory.parseExtraction(raw);
      if (!found) return result;

      const sources = [turn.userMessageId, turn.assistantMessageId].filter(Boolean);
      for (const entry of found) {
        /* `replaces` is only honoured when it names a memory that is actually there and still
         * active. A model that invents an id gets a new memory rather than a failed turn — and the
         * duplicate is visible in /memories rather than hidden. */
        const target = entry.replaces ? existing.find((m) => m.id === entry.replaces) : null;
        if (target) {
          store.supersedeMemory(s.db, target.id, {
            text: entry.text, createdAt: now(), sourceMessageIds: sources,
          });
          result.superseded++;
        } else {
          store.createMemory(s.db, {
            text: entry.text, createdAt: now(), sourceMessageIds: sources,
          });
          result.stored++;
        }
      }
    } catch (err) {
      result.error = err;
      if (opts.onMemoryError) opts.onMemoryError(err);
    }
    return result;
  }

  /* Persist a user message and open a turn. Returns the turn handle used by the stream.
   * Async since ADR-012 revision 1, because the topic decision may involve a request. */
  async function beginTurn(text) {
    const content = String(text == null ? '' : text);
    const turnId = 't' + (++turnSeq) + '-' + store.newId();
    const result = {
      turnId, userMessageId: null, assistantMessageId: null,
      historyBefore: [],
      /* The text being asked right now. messagesFor must put this last: without it the
       * model receives a conversation that ends on the assistant's previous reply and
       * simply continues from there, which reads as "answering the previous question". */
      userText: content,
      topicId: null,
      /* Why this message stayed in its topic or opened a new one, and whether a confirmation
       * backed that up: `confirmed` is true (model said new), false (model said no) or null
       * (nothing was asked). Not used in the reply path at all — it is what a wrong boundary
       * is diagnosed with (ADR-010). */
      topicReason: null,
      topicConfirmed: null,
    };

    if (!available) return result;

    const resolved = await resolveTopic(content);
    result.topicId = resolved.topic ? resolved.topic.id : null;
    result.topicReason = resolved.reason;
    result.topicConfirmed = resolved.confirmed;

    /* History as it was *before* this message, so the prompt does not contain the user
     * turn twice (once from the store, once from the caller) — and scoped to this message's
     * topic, so switching topics changes what she is reminded of. */
    result.historyBefore = result.topicId
      ? store.recentMessages(s.db, CONTEXT_MESSAGE_LIMIT, { topicId: result.topicId })
      : [];

    const userRow = store.appendMessage(s.db, {
      /* The row timestamp comes from the same reading of the clock as the boundary decision
       * above. Two separate readings could land either side of the idle threshold, and it
       * keeps the injected clock honest: a turn's timestamps and its topic decision agree. */
      role: 'user', content, turnId, topicId: result.topicId, createdAt: now(),
    });
    result.userMessageId = userRow.id;
    return result;
  }

  /* The messages to send to the API for an open turn: system, then the stored history,
   * then the message being answered. Remembered on the turn so the diagnostics written
   * alongside the reply reflect what was actually sent. */
  function messagesFor(turn) {
    const messages = buildMessages({
      persona: opts.persona,
      examples: opts.examples,
      identity: identity(),
      history: (turn && turn.historyBefore) || [],
      pickExample: opts.pickExample,
      /* Read at assembly time rather than captured earlier, so a memory stored by the previous
       * turn is already part of what this turn is told. */
      memories: activeMemoryList(),
      now: Date.now(),
    });
    if (turn && turn.userText) {
      messages.push({ role: 'user', content: turn.userText });
    }
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
        topicId: turn.topicId,
        model: opts.model || null,
        createdAt: now(),
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
    /* Kept on the turn so the extractor can see what was actually answered, and so a turn that is
     * being remembered carries its own reply rather than reading it back out of the store. */
    turn.assistantText = finalContent == null ? '' : String(finalContent);
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
      topicId: turn ? turn.topicId : null,
      createdAt: now(),
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
    listHistory,
    activeTopic,
    listTopics,
    switchTopic,
    newTopic,
    renameTopic,
    search,
    beginTurn,
    messagesFor,
    recordAssistantDelta,
    finishTurn,
    rememberTurn,
    memories,
    activeMemoryList,
    remember,
    forgetMemory,
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
  MEMORY_CONTEXT_LIMIT,
  MEMORY_INJECT_LIMIT,
  MEMORY_SECTION_MAX_CHARS,
  memorySection,
};
