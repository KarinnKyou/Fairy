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
 *   ADR-006  v0.1 has no topics table; migration 2 adds topic_id as nullable.
 *
 * This module deliberately knows nothing about IPC or the LLM. It reads and writes rows.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

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
 * never modify or reorder existing ones. Migration 2 is sketched in the comment so the
 * shape of Phase 2 is visible here rather than discovered later.
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

/* ------------------------------------------------------------------ messages */

/*
 * Append a message. Returns the stored row.
 * `turnId` groups the user message with the assistant reply it produced.
 */
function appendMessage(db, msg) {
  const createdAt = msg.createdAt == null ? nowMs() : msg.createdAt;
  /* The id embeds the same timestamp as the row, so ordering by (created_at, id) stays
   * deterministic even when several messages share a millisecond. Generating the id from
   * the wall clock instead would decouple the two and make the order arbitrary. */
  const id = msg.id || newId(createdAt);
  const content = msg.content == null ? '' : String(msg.content);
  db.prepare(
    'INSERT INTO messages (id, role, content, reasoning, turn_id, model, created_at, context_messages, prompt_chars) ' +
    'VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(id, msg.role, content, msg.reasoning == null ? null : String(msg.reasoning),
        msg.turnId == null ? null : String(msg.turnId), msg.model == null ? null : String(msg.model),
        createdAt,
        msg.contextMessages == null ? null : Number(msg.contextMessages),
        msg.promptChars == null ? null : Number(msg.promptChars));
  if (content) {
    db.prepare('INSERT INTO messages_fts (content, tok, message_id) VALUES (?, ?, ?)')
      .run(content, tokenizeForIndex(content), id);
  }
  return { id, role: msg.role, content, createdAt, turnId: msg.turnId || null };
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
 * `limit` counts messages, not turns. */
function recentMessages(db, limit) {
  const n = Math.max(0, limit == null ? 30 : limit);
  const rows = db.prepare(
    'SELECT id, role, content, reasoning, turn_id, model, created_at, context_messages, prompt_chars ' +
    'FROM messages ORDER BY created_at DESC, id DESC LIMIT ?'
  ).all(n);
  return rows.reverse().map(toMessage);
}

function listMessages(db, options) {
  const opts = options || {};
  const limit = Math.max(1, Math.min(1000, opts.limit == null ? 100 : opts.limit));
  const offset = Math.max(0, opts.offset == null ? 0 : opts.offset);
  const rows = db.prepare(
    'SELECT id, role, content, reasoning, turn_id, model, created_at, context_messages, prompt_chars ' +
    'FROM messages ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?'
  ).all(limit, offset);
  return rows.map(toMessage);
}

function countMessages(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
}

/* Full-text search. Available in v0.1 because the index ships with migration 1; the UI
 * for it arrives in Phase 2. Returns [] rather than throwing on an empty/unsearchable
 * query, so callers do not need to special-case it. */
function searchMessages(db, query, limit) {
  const match = toMatchQuery(query);
  if (!match) return [];
  const n = Math.max(1, Math.min(200, limit == null ? 20 : limit));
  const rows = db.prepare(
    `SELECT m.id, m.role, m.content, m.created_at
       FROM messages_fts f JOIN messages m ON m.id = f.message_id
      WHERE messages_fts MATCH ?
      ORDER BY rank LIMIT ?`
  ).all(match, n);
  return rows.map((r) => ({ id: r.id, role: r.role, content: r.content, createdAt: r.created_at }));
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
  appendMessage,
  updateMessage,
  recentMessages,
  listMessages,
  countMessages,
  searchMessages,
  /* exported for tests and for Phase 2 tooling that needs the same tokenization */
  tokenizeForIndex,
  toMatchQuery,
};
