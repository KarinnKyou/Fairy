'use strict';
/*
 * store.js — persistent state for HDD (main process only).
 *
 * Uses Node's built-in SQLite (`node:sqlite`), which ships with Electron's bundled Node
 * and has FTS5 compiled in. No native dependency, so no electron-rebuild step (see
 * docs/ADR.md ADR-002).
 *
 * Layering rules this module follows (docs/ADR.md):
 *   ADR-001  only the main process touches this; the renderer stays a display layer.
 *   ADR-003  the directory comes from getDataDir(): repo-local in development (easy to
 *            inspect), Electron's userData when packaged (the asar is read-only and a
 *            portable build unpacks to %TEMP%, so nothing else is writable).
 *   ADR-004  schema changes are append-only entries in MIGRATIONS, applied in a
 *            transaction. Never edit a shipped migration.
 *   ADR-005  ids are stable and time-sortable; timestamps are UTC epoch milliseconds.
 *   ADR-006  v0.1 shipped no topics table; migration 3 adds `topics` and a nullable
 *            `messages.topic_id`, then backfills what was the single implicit conversation.
 *   ADR-012  how a topic boundary is decided, and why titles are derived rather than
 *            generated.
 *
 * This module deliberately knows nothing about IPC or the LLM. It reads and writes rows.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
/* Only for titleFromText during the backfill: naming a topic is policy, and policy lives in
 * one place. Nothing else here depends on it. */
const topics = require('./topics.js');

/* ------------------------------------------------------------------ ids and time */

/*
 * Time-sortable, collision-resistant id: "<16-digit ms>-<4-digit seq>-<8 hex chars>".
 *
 * - The millisecond part is zero-padded to a fixed width so lexicographic order equals
 *   chronological order across digit-count boundaries.
 * - The sequence number disambiguates messages created within the same millisecond. It
 *   must be there: a purely random suffix would make two messages written in the same
 *   millisecond sort in arbitrary order, so insertion order would not be recoverable.
 * - The random suffix keeps ids unique across processes and restarts.
 *
 * 16 digits covers timestamps up to the year 33658.
 */
const ID_MS_WIDTH = 16;
const ID_SEQ_WIDTH = 4;
const ID_SEQ_MAX = 9999;

let lastIdMs = -1;
let idSeq = 0;

function newId(now) {
  const ms = now == null ? Date.now() : now;
  if (ms === lastIdMs) {
    idSeq = idSeq >= ID_SEQ_MAX ? 0 : idSeq + 1;   /* wrap rather than grow unbounded */
  } else {
    lastIdMs = ms;
    idSeq = 0;
  }
  return String(ms).padStart(ID_MS_WIDTH, '0') + '-' +
    String(idSeq).padStart(ID_SEQ_WIDTH, '0') + '-' +
    crypto.randomBytes(4).toString('hex');
}

function nowMs() {
  return Date.now();
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/* ------------------------------------------------------------------ tokenizing */

/*
 * FTS5's default tokenizer (and every built-in alternative) treats a run of CJK as a
 * single token, so searching for 终端 in 我在做终端项目 finds nothing. The trigram
 * tokenizer only matches 3+ characters, which rules out the two-character words that
 * dominate Chinese queries.
 *
 * So the index stores a second, pre-tokenized copy of the text: CJK characters are split
 * one per token, Latin words are left whole. Queries are tokenized the same way and ANDed
 * together — adjacent-index matches then behave like a phrase.
 *
 * Verified: 终端 / 终端项目 / 做 / 天气不错 / HDD all match; unrelated text does not.
 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\u3000-\u303f\uff00-\uffef]/;

function tokenizeForIndex(text) {
  return String(text == null ? '' : text)
    .replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\u3000-\u303f\uff00-\uffef]/g,
      (ch) => ' ' + ch + ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* Build an FTS5 MATCH expression. Returns null when there is nothing searchable. */
function toMatchQuery(query) {
  const s = String(query == null ? '' : query).trim();
  if (!s) return null;
  if (!CJK_RE.test(s)) {
    /* Pure Latin: hand it to FTS5 as a phrase so punctuation cannot become syntax. */
    return '"' + s.replace(/"/g, '""') + '"';
  }
  const terms = tokenizeForIndex(s).split(' ').filter(Boolean);
  if (!terms.length) return null;
  return terms.map((t) => '"' + t.replace(/"/g, '""') + '"').join(' ');
}

/* ------------------------------------------------------------------ schema */

/*
 * Append-only. Each entry is [version, sql]. To change the schema, add a new entry;
 * never modify or reorder existing ones.
 */
const MIGRATIONS = [
  [
    1,
    `
    CREATE TABLE messages (
      id          TEXT PRIMARY KEY,
      role        TEXT NOT NULL CHECK (role IN ('user','assistant','system','error')),
      content     TEXT NOT NULL DEFAULT '',
      reasoning   TEXT,
      turn_id     TEXT,
      model       TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX idx_messages_created ON messages(created_at, id);

    -- Full-text index. Column 'content' keeps the readable text; 'tok' holds the
    -- CJK-tokenized copy used for matching (see tokenizeForIndex). Kept in sync explicitly
    -- by the write paths below rather than by triggers, so the sync logic lives in one
    -- place. NOTE: no backticks in this SQL - it sits inside a JS template literal.
    CREATE VIRTUAL TABLE messages_fts USING fts5(content, tok, message_id UNINDEXED);

    CREATE TABLE meta (
      key    TEXT PRIMARY KEY,
      value  TEXT NOT NULL
    );
    `,
  ],
  // [2, `
  //   ALTER TABLE messages ADD COLUMN topic_id TEXT;
  //   CREATE TABLE topics (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  //   CREATE INDEX idx_messages_topic ON messages(topic_id, created_at, id);
  // `],
  [
    2,
    `
    -- How many messages were sent to the model for this turn, and how long the system
    -- prompt was. Stored so a bad reply can be diagnosed from the transcript alone:
    -- "\u6ca1\u5e26\u5386\u53f2" and "\u5386\u53f2\u5f88\u957f" look identical on screen but differ here.
    ALTER TABLE messages ADD COLUMN context_messages INTEGER;
    ALTER TABLE messages ADD COLUMN prompt_chars INTEGER;
    `,
  ],
  [
    3,
    `
    -- Topics (Phase 2, ADR-012). updated_at is what orders the topic list: the subject you
    -- were last talking about is the one you want at the top, not the one created last.
    CREATE TABLE topics (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX idx_topics_updated ON topics(updated_at, id);

    -- Added nullable, as ADR-006 required, so this stays an additive migration: existing
    -- rows get NULL and backfillTopics() then assigns them. A NOT NULL column could not
    -- have been added without rewriting every row inside the migration itself.
    ALTER TABLE messages ADD COLUMN topic_id TEXT;
    CREATE INDEX idx_messages_topic ON messages(topic_id, created_at, id);
    `,
  ],
  [
    4,
    `
    -- Whether a topic's title is final. It is set when the user renames the topic, and when the
    -- title was derived from a message carrying enough content to name a subject. A topic whose
    -- title is still open is provisional: it can be renamed by its first substantial message,
    -- which is what stops a session that opens with "你好" from being called that forever.
    ALTER TABLE topics ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0;
    `,
  ],
  [
    5,
    `
    -- Memories (Phase 3, ADR-013): structured facts about the owner, each traceable to the
    -- messages it came from.
    --
    -- There is no "active" column on purpose. A memory is active exactly while nothing has
    -- superseded it, so superseded_by IS NULL *is* the status; a second column could disagree
    -- with it and then two queries would return different answers to the same question. The
    -- CHECK keeps the pair together, and the partial index keeps the common query cheap.
    CREATE TABLE memories (
      id            TEXT PRIMARY KEY,
      text          TEXT NOT NULL,
      origin        TEXT NOT NULL DEFAULT 'inferred' CHECK (origin IN ('inferred','owner')),
      created_at    INTEGER NOT NULL,
      superseded_by TEXT REFERENCES memories(id),
      superseded_at INTEGER,
      CHECK ((superseded_by IS NULL) = (superseded_at IS NULL))
    );
    CREATE INDEX idx_memories_active ON memories(created_at, id) WHERE superseded_by IS NULL;

    -- Which messages a memory came from: many-to-many, because one memory can distil several
    -- turns and one turn can carry several memories. ON DELETE CASCADE means forgetting a memory
    -- takes its provenance with it; the reference to messages is deliberate, so a link can never
    -- point at a message that does not exist.
    CREATE TABLE memory_sources (
      memory_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES messages(id),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (memory_id, message_id)
    );
    CREATE INDEX idx_memory_sources_message ON memory_sources(message_id);
    `,
  ],
];

const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1][0];

/* ------------------------------------------------------------------ location */

/*
 * Resolve the data directory.
 *
 * Order of precedence:
 *   1. HDD_DATA_DIR — explicit override. Used by scripts/dev.cjs so test conversations go
 *      to a scratch directory instead of the real one.
 *   2. Electron's userData directory, when packaged: the app itself lives inside a
 *      read-only asar and a portable build re-unpacks into %TEMP% on every launch.
 *   3. <project>/app/data — development, repo-local and gitignored, easy to inspect.
 */
function getDataDir(options) {
  const opts = options || {};
  if (opts.dir) return opts.dir;
  if (process.env.HDD_DATA_DIR) return process.env.HDD_DATA_DIR;

  const electronApp = opts.electronApp || tryRequireElectronApp();
  if (electronApp && electronApp.isPackaged) {
    return path.join(electronApp.getPath('userData'), 'data');
  }
  return path.join(__dirname, 'data');
}

/* Delete the store and its WAL sidecars. Used by the dev scratch workflow.
 *
 * Refuses to touch a directory unless the caller confirms it is scratch space: losing a
 * real conversation should never be one stray argument away. */
function resetDataDir(dir, options) {
  const opts = options || {};
  if (!opts.force) {
    throw new Error('resetDataDir refuses to delete without { force: true }');
  }
  if (!dir) throw new Error('resetDataDir needs a directory');
  const files = [];
  for (const name of ['hdd.db', 'hdd.db-wal', 'hdd.db-shm']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) files.push(p);
  }
  for (const p of files) fs.rmSync(p, { force: true });
  return files.length;
}

function tryRequireElectronApp() {
  try {
    const electron = require('electron');
    return electron && electron.app ? electron.app : null;
  } catch (_) {
    return null;
  }
}

/* ------------------------------------------------------------------ opening */

function applyMigrations(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get();
  let current = row ? row.version : 0;

  if (current === 0) {
    db.exec('INSERT INTO schema_version (version) VALUES (0)');
  }
  if (current > SCHEMA_VERSION) {
    throw new Error(
      'database schema is newer than this build (db=' + current + ', app=' + SCHEMA_VERSION +
      '). Refusing to open it; a downgrade would corrupt data.'
    );
  }

  for (const [version, sql] of MIGRATIONS) {
    if (version <= current) continue;
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.exec('UPDATE schema_version SET version = ' + version);
      db.exec('COMMIT');
      current = version;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
      throw new Error('migration ' + version + ' failed: ' + err.message);
    }
  }
  return current;
}

/* Open (creating if needed) the store. Pass { dir } to point at a scratch directory —
 * used by the tests so they never touch real data. */
function open(options) {
  const opts = options || {};
  const dir = getDataDir(opts);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, opts.file || 'hdd.db');

  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode = WAL');   /* survive an abrupt exit */
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA synchronous = NORMAL');
    const version = applyMigrations(db);
    /* Separate from the migrations on purpose: this needs an application-generated id and
     * the title policy, neither of which belongs in a SQL migration (ADR-005, ADR-012). */
    backfillTopics(db);
    return { db, file, dir, schemaVersion: version };
  } catch (err) {
    /* Close before propagating: an open handle keeps the -wal/-shm files alive and the
     * directory cannot be removed afterwards. */
    try { db.close(); } catch (_) { /* already unusable */ }
    throw err;
  }
}

/* ------------------------------------------------------------------ meta */

function metaGet(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function metaSet(db, key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

/* Initialise the identity facts Phase 1 needs, without overwriting them later.
 *
 * `first_seen` is NOT stamped here: opening a database is not a first meeting. It is
 * stamped by the first completed turn (see bumpTurns), so "first seen" means "when we
 * first talked", not "when the file appeared". */
function ensureIdentity(db) {
  if (metaGet(db, 'turns') == null) metaSet(db, 'turns', 0);
  return {
    firstSeen: Number(metaGet(db, 'first_seen') || 0),
    turns: Number(metaGet(db, 'turns') || 0),
  };
}

function bumpTurns(db, delta) {
  /* The first completed turn is what establishes the relationship. */
  if (metaGet(db, 'first_seen') == null) metaSet(db, 'first_seen', nowMs());
  const n = Number(metaGet(db, 'turns') || 0) + (delta == null ? 1 : delta);
  metaSet(db, 'turns', n);
  metaSet(db, 'last_seen', nowMs());
  return n;
}

/* ------------------------------------------------------------------ topics */

/* The topic the app is currently writing into, remembered across restarts. Stored in meta
 * rather than in a table so a restart resumes where the conversation left off without any
 * extra row lifecycle. */
const META_CURRENT_TOPIC = 'current_topic';

function createTopic(db, topic) {
  const opts = topic || {};
  const createdAt = opts.createdAt == null ? nowMs() : opts.createdAt;
  const updatedAt = opts.updatedAt == null ? createdAt : opts.updatedAt;
  const id = opts.id || newId(createdAt);
  const raw = String(opts.title == null ? '' : opts.title).trim();
  const title = raw || topics.FALLBACK_TITLE;
  const titleLocked = opts.titleLocked ? 1 : 0;
  db.prepare('INSERT INTO topics (id, title, created_at, updated_at, title_locked) VALUES (?,?,?,?,?)')
    .run(id, title, createdAt, updatedAt, titleLocked);
  return { id, title, createdAt, updatedAt, titleLocked: Boolean(titleLocked) };
}

function getTopic(db, id) {
  if (!id) return null;
  const row = db.prepare('SELECT * FROM topics WHERE id = ?').get(id);
  return row ? toTopic(row) : null;
}

/* Newest activity first: this is the order the topic list is read in, and the order the
 * /switch index refers to. Ties break on id so the order is stable. */
function listTopics(db, options) {
  const opts = options || {};
  const limit = clamp(opts.limit == null ? 100 : Number(opts.limit), 1, 1000);
  const offset = Math.max(0, opts.offset == null ? 0 : Number(opts.offset));
  const rows = db.prepare(
    `SELECT t.*, (SELECT COUNT(*) FROM messages m WHERE m.topic_id = t.id) AS message_count
       FROM topics t ORDER BY t.updated_at DESC, t.id DESC LIMIT ? OFFSET ?`
  ).all(limit, offset);
  return rows.map((r) => Object.assign(toTopic(r), { messageCount: Number(r.message_count) }));
}

/*
 * Renaming by the user makes the title final, so nothing else renames it afterwards. Refuses
 * an empty title instead of writing one: a topic with no name cannot be recognised in the list,
 * and '' is what an accidental empty argument looks like.
 */
function renameTopic(db, id, title) {
  const clean = String(title == null ? '' : title).trim();
  if (!clean) return null;
  const res = db.prepare('UPDATE topics SET title = ?, updated_at = ?, title_locked = 1 WHERE id = ?')
    .run(clean, nowMs(), id);
  if (!res.changes) return null;
  return getTopic(db, id);
}

/*
 * Name a topic that is still provisional — one whose title came from a message too thin to
 * name a subject (a greeting, usually). The first substantial message in that topic takes over
 * the naming, and locks it: after that the title is as good as it is going to get without the
 * user renaming it.
 *
 * Refuses when the title is already locked, so a user's own name is never overwritten. Returns
 * the updated topic, or null when nothing changed.
 */
function retitleTopic(db, id, title) {
  const topic = getTopic(db, id);
  if (!topic || topic.titleLocked) return null;
  const clean = String(title == null ? '' : title).trim();
  if (!clean || clean === topic.title) {
    /* Nothing to gain, but stop asking: an unchanged name would be retried on every message. */
    if (clean === topic.title) db.prepare('UPDATE topics SET title_locked = 1 WHERE id = ?').run(id);
    return null;
  }
  db.prepare('UPDATE topics SET title = ?, title_locked = 1 WHERE id = ?').run(clean, id);
  return getTopic(db, id);
}

/*
 * Move every message from one topic into another and delete the emptied one.
 *
 * Used when a confirmation opens a new topic and the topic being left behind is still
 * provisional — typically it holds nothing but a greeting ("你好", "在吗") that was never
 * enough to name a subject. Absorbing it keeps the greeting with the conversation it opened,
 * instead of accumulating one nameless topic per sitting.
 *
 * Refuses to absorb a locked topic: that is a subject the user has seen named, and silently
 * merging it would be the kind of data change this project does not do behind anyone's back.
 */
function absorbTopic(db, fromId, intoId) {
  const from = getTopic(db, fromId);
  const into = getTopic(db, intoId);
  if (!from || !into || from.id === into.id) return null;
  if (from.titleLocked) return null;

  db.exec('BEGIN');
  try {
    const res = db.prepare('UPDATE messages SET topic_id = ? WHERE topic_id = ?').run(into.id, from.id);
    db.prepare('DELETE FROM topics WHERE id = ?').run(from.id);
    touchTopic(db, into.id);
    db.exec('COMMIT');
    return { moved: Number(res.changes), into: getTopic(db, into.id) };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw new Error('absorbTopic failed: ' + err.message);
  }
}

/* Called when a message lands in the topic, so the list order follows the conversation. */
function touchTopic(db, id, at) {
  if (!id) return;
  db.prepare('UPDATE topics SET updated_at = ? WHERE id = ?').run(at == null ? nowMs() : at, id);
}

function countTopics(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM topics').get().n;
}

function getCurrentTopic(db) {
  const id = metaGet(db, META_CURRENT_TOPIC);
  const topic = getTopic(db, id);
  if (topic) return topic;
  /* The remembered topic is gone (or was never set): fall back to the most recent one so a
   * restart resumes the conversation that was actually in progress. */
  const newest = listTopics(db, { limit: 1 })[0];
  if (newest) metaSet(db, META_CURRENT_TOPIC, newest.id);
  return newest || null;
}

function setCurrentTopic(db, id) {
  const topic = getTopic(db, id);
  if (!topic) return null;
  metaSet(db, META_CURRENT_TOPIC, topic.id);
  return topic;
}

/*
 * Migration 3 adds topic_id as NULL for everything written before Phase 2. Those rows are
 * exactly the v0.1 store's single implicit conversation (ADR-006), so they become exactly
 * one topic rather than being re-segmented by the detector: splitting history would be
 * guessing at boundaries nobody recorded, and it would make the upgrade unreproducible —
 * a topic layout that depends on when you upgraded.
 *
 * Idempotent: with no NULL rows left it does nothing, so a crash mid-backfill is repaired by
 * the next open.
 */
function backfillTopics(db) {
  const pending = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE topic_id IS NULL').get().n;
  if (!pending) return null;

  const first = db.prepare(
    "SELECT content, created_at FROM messages WHERE topic_id IS NULL AND role = 'user' " +
    'ORDER BY created_at ASC, id ASC LIMIT 1'
  ).get();
  const at = first ? first.created_at : nowMs();
  db.exec('BEGIN');
  try {
    const topic = createTopic(db, {
      title: topics.titleFromText(first ? first.content : ''),
      createdAt: at,
      updatedAt: at,
      /* Locked on purpose. The title of a migrated topic comes from the whole of a real
       * conversation, so re-deriving it from whichever single message happens to arrive next
       * would mislabel hundreds of messages. `/rename` is the way to change it. */
      titleLocked: true,
    });
    db.prepare('UPDATE messages SET topic_id = ? WHERE topic_id IS NULL').run(topic.id);
    /* Only claim it as current if nothing else has: an upgrade must not steal the active
     * topic from a store that already had one. */
    if (metaGet(db, META_CURRENT_TOPIC) == null) metaSet(db, META_CURRENT_TOPIC, topic.id);
    db.exec('COMMIT');
    return topic;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw new Error('topic backfill failed: ' + err.message);
  }
}

/* ------------------------------------------------------------------ messages */

/*
 * Append a message. Returns the stored row.
 * `turnId` groups the user message with the assistant reply it produced.
 * `topicId` is the subject it belongs to; leaving it out is only correct for a store that
 * has no topics yet, since the column is nullable by design (ADR-006).
 *
 * Appending also bumps the topic's updated_at, because writing a message is the activity the
 * topic list is ordered by. Doing it here keeps that true for every write path instead of
 * relying on each caller to remember.
 */
function appendMessage(db, msg) {
  const createdAt = msg.createdAt == null ? nowMs() : msg.createdAt;
  /* The id embeds the same timestamp as the row, so ordering by (created_at, id) stays
   * deterministic even when several messages share a millisecond. Generating the id from
   * the wall clock instead would decouple the two and make the order arbitrary. */
  const id = msg.id || newId(createdAt);
  const content = msg.content == null ? '' : String(msg.content);
  const topicId = msg.topicId == null ? null : String(msg.topicId);
  db.prepare(
    'INSERT INTO messages (id, role, content, reasoning, turn_id, model, created_at, context_messages, prompt_chars, topic_id) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(id, msg.role, content, msg.reasoning == null ? null : String(msg.reasoning),
        msg.turnId == null ? null : String(msg.turnId), msg.model == null ? null : String(msg.model),
        createdAt,
        msg.contextMessages == null ? null : Number(msg.contextMessages),
        msg.promptChars == null ? null : Number(msg.promptChars),
        topicId);
  if (content) {
    db.prepare('INSERT INTO messages_fts (content, tok, message_id) VALUES (?, ?, ?)')
      .run(content, tokenizeForIndex(content), id);
  }
  if (topicId) touchTopic(db, topicId, createdAt);
  return { id, role: msg.role, content, createdAt, turnId: msg.turnId || null, topicId };
}

/* Update an existing message in place — used when a streamed reply finishes and the
 * final text is known. Keeps the full-text index in step. */
function updateMessage(db, id, patch) {
  const existing = db.prepare('SELECT id, content FROM messages WHERE id = ?').get(id);
  if (!existing) return null;
  const sets = [];
  const vals = [];
  if (patch.content != null) { sets.push('content = ?'); vals.push(String(patch.content)); }
  if (patch.reasoning != null) { sets.push('reasoning = ?'); vals.push(String(patch.reasoning)); }
  if (patch.contextMessages != null) { sets.push('context_messages = ?'); vals.push(Number(patch.contextMessages)); }
  if (patch.promptChars != null) { sets.push('prompt_chars = ?'); vals.push(Number(patch.promptChars)); }
  if (!sets.length) return existing;
  vals.push(id);
  db.prepare('UPDATE messages SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals);

  if (patch.content != null) {
    db.prepare('DELETE FROM messages_fts WHERE message_id = ?').run(id);
    if (patch.content) {
      db.prepare('INSERT INTO messages_fts (content, tok, message_id) VALUES (?, ?, ?)')
        .run(String(patch.content), tokenizeForIndex(patch.content), id);
    }
  }
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
}

/* Chronological window, oldest first — ready to hand to the chat API.
 * `limit` counts messages, not turns.
 * `options.topicId` scopes the window to one subject, which is what makes switching topics
 * change what she is reminded of (ADR-012). It is an options object rather than a third
 * positional argument so the existing two-argument calls keep their meaning. */
function recentMessages(db, limit, options) {
  const n = Math.max(0, limit == null ? 30 : limit);
  const topicId = options && options.topicId;
  const where = topicId ? ' WHERE topic_id = ?' : '';
  const rows = db.prepare(
    'SELECT id, role, content, reasoning, turn_id, model, created_at, context_messages, prompt_chars, topic_id ' +
    'FROM messages' + where + ' ORDER BY created_at DESC, id DESC LIMIT ?'
  ).all(...(topicId ? [String(topicId), n] : [n]));
  return rows.reverse().map(toMessage);
}

function listMessages(db, options) {
  const opts = options || {};
  const limit = clamp(opts.limit == null ? 100 : Number(opts.limit), 1, 1000);
  const offset = Math.max(0, opts.offset == null ? 0 : Number(opts.offset));
  const topicId = opts.topicId;
  const where = topicId ? ' WHERE topic_id = ?' : '';
  const rows = db.prepare(
    'SELECT id, role, content, reasoning, turn_id, model, created_at, context_messages, prompt_chars, topic_id ' +
    'FROM messages' + where + ' ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?'
  ).all(...(topicId ? [String(topicId), limit, offset] : [limit, offset]));
  return rows.map(toMessage);
}

function countMessages(db, options) {
  const topicId = options && options.topicId;
  if (!topicId) return db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  return db.prepare('SELECT COUNT(*) AS n FROM messages WHERE topic_id = ?').get(String(topicId)).n;
}

/* When the newest message in a topic was written. 0 when there is none.
 * The topic detector needs this to tell "a new sentence" from "a new sitting" (ADR-012). */
function lastMessageAt(db, topicId) {
  const row = topicId
    ? db.prepare('SELECT MAX(created_at) AS t FROM messages WHERE topic_id = ?').get(String(topicId))
    : db.prepare('SELECT MAX(created_at) AS t FROM messages').get();
  return row && row.t != null ? Number(row.t) : 0;
}

/* Move a message to another topic. Not used by the conversation flow (a message is written
 * with its topic already decided) but needed to repair a database by hand, and by the Phase 9
 * merge/import path. */
function setMessageTopic(db, messageId, topicId) {
  const topic = getTopic(db, topicId);
  if (!topic) return null;
  const res = db.prepare('UPDATE messages SET topic_id = ? WHERE id = ?').run(topic.id, messageId);
  if (!res.changes) return null;
  touchTopic(db, topic.id);
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
}

/* Full-text search over every topic by default. `options.topicId` narrows it to one, and
 * `options.withTopic` attaches the topic title so a hit can be shown with where it came from.
 * Returns [] rather than throwing on an empty/unsearchable query, so callers do not need to
 * special-case it. Any search feature must go through toMatchQuery (ADR-002). */
function searchMessages(db, query, limit, options) {
  const match = toMatchQuery(query);
  if (!match) return [];
  const opts = options || {};
  const n = clamp(limit == null ? 20 : Number(limit), 1, 200);
  const topicId = opts.topicId;
  const where = topicId ? ' AND m.topic_id = ?' : '';
  const rows = db.prepare(
    `SELECT m.id, m.role, m.content, m.created_at, m.topic_id, t.title AS topic_title
       FROM messages_fts f
       JOIN messages m ON m.id = f.message_id
       LEFT JOIN topics t ON t.id = m.topic_id
      WHERE messages_fts MATCH ?` + where + `
      ORDER BY rank LIMIT ?`
  ).all(...(topicId ? [match, String(topicId), n] : [match, n]));
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    createdAt: r.created_at,
    topicId: r.topic_id,
    topicTitle: r.topic_title,
  }));
}

function toTopic(row) {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    titleLocked: Boolean(row.title_locked),
  };
}

function toMessage(row) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    reasoning: row.reasoning,
    turnId: row.turn_id,
    model: row.model,
    createdAt: row.created_at,
    contextMessages: row.context_messages == null ? null : Number(row.context_messages),
    promptChars: row.prompt_chars == null ? null : Number(row.prompt_chars),
    topicId: row.topic_id == null ? null : row.topic_id,
  };
}

/* ------------------------------------------------------------------ memories */

/*
 * Store one memory, with the messages it came from.
 *
 * `sourceMessageIds` is not optional in spirit: a memory without provenance cannot be traced back
 * to what produced it, and that traceability is the property Phase 3 asks for. The links are
 * written in the same transaction as the memory, so a memory is never briefly sourceless.
 *
 * A missing message id is refused rather than skipped. The reference is a foreign key, so a
 * skipped link would mean the caller believes a memory came from something the store never had —
 * a silent lie about where a belief came from.
 */
function createMemory(db, memory) {
  const opts = memory || {};
  const text = String(opts.text == null ? '' : opts.text).trim();
  if (!text) throw new Error('a memory needs text');
  const createdAt = opts.createdAt == null ? nowMs() : opts.createdAt;
  const id = opts.id || newId(createdAt);
  const origin = opts.origin === 'owner' ? 'owner' : 'inferred';
  const sources = (opts.sourceMessageIds || []).map(String);

  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO memories (id, text, origin, created_at) VALUES (?,?,?,?)')
      .run(id, text, origin, createdAt);
    for (const messageId of sources) {
      db.prepare('INSERT OR IGNORE INTO memory_sources (memory_id, message_id, created_at) VALUES (?,?,?)')
        .run(id, messageId, createdAt);
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw new Error('could not store the memory: ' + err.message);
  }
  return getMemory(db, id);
}

function getMemory(db, id) {
  if (!id) return null;
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
  return row ? toMemory(row) : null;
}

/* Active memories, newest first. `includeSuperseded` is for inspection and for the evaluation set;
 * the prompt only ever sees active ones.
 *
 * `sourceCount` is carried on every row because provenance is only useful if it is visible: a
 * memory that says nothing about where it came from cannot be argued with. */
function listMemories(db, options) {
  const opts = options || {};
  const limit = clamp(opts.limit == null ? 100 : Number(opts.limit), 1, 1000);
  const offset = Math.max(0, opts.offset == null ? 0 : Number(opts.offset));
  const where = opts.includeSuperseded ? '' : ' WHERE m.superseded_by IS NULL';
  return db.prepare(
    `SELECT m.*, (SELECT COUNT(*) FROM memory_sources s WHERE s.memory_id = m.id) AS source_count
       FROM memories m` + where + `
      ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`
  ).all(limit, offset).map(toMemory);
}

/*
 * What goes into the prompt: a bounded slice of what she currently believes. Newest first,
 * because a newer belief is more likely to still be true — and capped by the caller, since
 * ADR-008 warns about the prompt budget.
 */
function activeMemories(db, limit) {
  return listMemories(db, { limit: limit == null ? 20 : limit });
}

function countMemories(db, options) {
  const opts = options || {};
  const sql = opts.includeSuperseded
    ? 'SELECT COUNT(*) AS n FROM memories'
    : 'SELECT COUNT(*) AS n FROM memories WHERE superseded_by IS NULL';
  return db.prepare(sql).get().n;
}

/* The messages a memory came from, oldest first — the order they were said in. */
function memorySources(db, memoryId) {
  return db.prepare(
    `SELECT m.id, m.role, m.content, m.created_at, m.topic_id
       FROM memory_sources s JOIN messages m ON m.id = s.message_id
      WHERE s.memory_id = ?
      ORDER BY m.created_at ASC, m.id ASC`
  ).all(String(memoryId)).map((r) => ({
    id: r.id, role: r.role, content: r.content, createdAt: r.created_at, topicId: r.topic_id,
  }));
}

/* Which memories were drawn from a given message — what makes the provenance usable in reverse,
 * e.g. "this message produced these beliefs". */
function memoriesFromMessage(db, messageId) {
  return db.prepare(
    `SELECT m.* FROM memory_sources s JOIN memories m ON m.id = s.memory_id
      WHERE s.message_id = ?
      ORDER BY m.created_at ASC, m.id ASC`
  ).all(String(messageId)).map(toMemory);
}

/* The whole supersession chain ending at `id`, oldest first: A <- B <- id.
 *
 * Walking it is what makes deletion safe. The self-reference on superseded_by is enforced by the
 * database, so a successor cannot be removed while its predecessor still points at it — the error
 * is loud instead of leaving a pointer to a row that is gone, and a predecessor whose pointer was
 * cleared would read as active again, resurrecting a fact the user just asked to forget. */
function memoryChain(db, id) {
  const chain = [];
  const seen = new Set();
  let current = getMemory(db, id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    const predecessor = db.prepare('SELECT * FROM memories WHERE superseded_by = ?').get(current.id);
    current = predecessor ? toMemory(predecessor) : null;
  }
  return chain;
}

/*
 * Correct a memory: append the replacement and mark what it replaces, in one transaction. The old
 * row is kept, because "what she used to believe, and when it changed" is the thing that makes a
 * wrong memory trustworthy rather than merely gone (ADR-013).
 */
function supersedeMemory(db, oldId, replacement) {
  const old = getMemory(db, oldId);
  if (!old) return null;
  if (old.supersededBy) throw new Error('memory ' + oldId + ' was already superseded');

  const opts = replacement || {};
  const createdAt = opts.createdAt == null ? nowMs() : opts.createdAt;
  const id = opts.id || newId(createdAt);
  const text = String(opts.text == null ? '' : opts.text).trim();
  if (!text) throw new Error('a memory needs text');
  const origin = opts.origin === 'owner' ? 'owner' : 'inferred';
  const sources = (opts.sourceMessageIds || []).map(String);

  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO memories (id, text, origin, created_at) VALUES (?,?,?,?)')
      .run(id, text, origin, createdAt);
    for (const messageId of sources) {
      db.prepare('INSERT OR IGNORE INTO memory_sources (memory_id, message_id, created_at) VALUES (?,?,?)')
        .run(id, messageId, createdAt);
    }
    db.prepare('UPDATE memories SET superseded_by = ?, superseded_at = ? WHERE id = ?')
      .run(id, createdAt, old.id);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw new Error('could not supersede the memory: ' + err.message);
  }
  return getMemory(db, id);
}

/*
 * Forget a memory and everything it superseded, oldest first.
 *
 * The whole chain goes because a chain is one fact at successive moments: removing only the newest
 * would either leave its predecessors pointing at a row that no longer exists, or — worse — make
 * one of them active again, quietly restoring the belief the user just asked to be rid of. Source
 * links go with each row (ON DELETE CASCADE).
 */
function forgetMemory(db, id) {
  const chain = memoryChain(db, id);
  if (!chain.length) return 0;

  db.exec('BEGIN');
  try {
    for (const memory of chain) {
      db.prepare('DELETE FROM memories WHERE id = ?').run(memory.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw new Error('could not forget the memory: ' + err.message);
  }
  return chain.length;
}

function toMemory(row) {
  return {
    id: row.id,
    text: row.text,
    origin: row.origin,
    createdAt: row.created_at,
    supersededBy: row.superseded_by == null ? null : row.superseded_by,
    supersededAt: row.superseded_at == null ? null : Number(row.superseded_at),
    active: row.superseded_by == null,
    /* Null rather than 0 when the query did not ask for it, so "no sources" and "not counted"
     * cannot be confused by a caller that only wants to display it. */
    sourceCount: row.source_count == null ? null : Number(row.source_count),
  };
}

/* ------------------------------------------------------------------ teardown */

function close(store) {
  if (store && store.db) {
    try { store.db.close(); } catch (_) { /* already closed */ }
  }
}

module.exports = {
  open,
  close,
  getDataDir,
  resetDataDir,
  newId,
  nowMs,
  applyMigrations,
  MIGRATIONS,
  SCHEMA_VERSION,
  metaGet,
  metaSet,
  ensureIdentity,
  bumpTurns,
  createTopic,
  getTopic,
  listTopics,
  renameTopic,
  retitleTopic,
  absorbTopic,
  touchTopic,
  countTopics,
  getCurrentTopic,
  setCurrentTopic,
  backfillTopics,
  META_CURRENT_TOPIC,
  appendMessage,
  updateMessage,
  recentMessages,
  listMessages,
  countMessages,
  lastMessageAt,
  setMessageTopic,
  searchMessages,
  createMemory,
  getMemory,
  listMemories,
  activeMemories,
  countMemories,
  memorySources,
  memoriesFromMessage,
  memoryChain,
  supersedeMemory,
  forgetMemory,
  /* exported for tests and for Phase 2 tooling that needs the same tokenization */
  tokenizeForIndex,
  toMatchQuery,
};
