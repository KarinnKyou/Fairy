'use strict';
/*
 * store.test.cjs — data layer regression tests (plain Node, no Electron).
 *
 * Covers ids and ordering, migrations and the downgrade guard, the CJK full-text index,
 * topics and their backfill (migration 3), and data-directory resolution.
 *
 * Everything runs against a scratch directory that is deleted afterwards, so the tests
 * never touch real data. Run: node tests/store.test.cjs
 */

const fs = require('fs');
const path = require('path');
const store = require('../store.js');
const topics = require('../topics.js');

let failed = 0;
function check(cond, msg) {
  if (cond) { console.log('PASS ' + msg); } else { console.log('FAIL ' + msg); failed++; }
}

/* A scratch directory inside app/ so the sandbox never has to reach outside the project. */
const scratch = path.join(__dirname, '..', '.tmp-store-test');
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });

function fresh(name) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, s: store.open({ dir }) };
}

/* ---------------------------------------------------------------- 1. creation */
{
  const { dir, s } = fresh('create');
  check(fs.existsSync(path.join(dir, 'hdd.db')), '创建了 hdd.db');
  check(s.schemaVersion === store.SCHEMA_VERSION,
    '全新库直接到最新 schema（v' + s.schemaVersion + '）');

  const tables = s.db.prepare(
    "SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name"
  ).all().map((r) => r.name);
  for (const t of ['messages', 'messages_fts', 'meta', 'schema_version']) {
    check(tables.includes(t), '存在表 ' + t);
  }
  /* FTS5 was the reason for choosing SQLite (ADR-002): prove it is really there. */
  check(tables.includes('messages_fts_data') || tables.includes('messages_fts'),
    'FTS5 虚表已建立');
  store.close(s);
}

/* ---------------------------------------------------------------- 2. reopen is a no-op */
{
  const { dir, s } = fresh('reopen');
  store.appendMessage(s.db, { role: 'user', content: '第一句' });
  store.close(s);

  const s2 = store.open({ dir });
  check(s2.schemaVersion === store.SCHEMA_VERSION, '重开后 schema 版本不变');
  check(store.countMessages(s2.db) === 1, '重开后消息仍在（数据真的落盘了）');
  store.close(s2);
}

/* ---------------------------------------------------------------- 3. ids and order */
{
  const { s } = fresh('ids');
  const a = store.appendMessage(s.db, { role: 'user', content: 'A' });
  const b = store.appendMessage(s.db, { role: 'assistant', content: 'B' });
  check(a.id !== b.id, '每条消息 id 唯一');
  check(/^\d{16}-\d{4}-[0-9a-f]{8}$/.test(a.id), 'id 形如 <16位毫秒>-<4位序号>-<8hex>：' + a.id);
  check(typeof a.createdAt === 'number', 'createdAt 是数字（UTC 毫秒）');

  /* Ids must sort chronologically as plain strings, including across digit-count
   * boundaries — that is exactly why the timestamp part is zero-padded. */
  const early = store.newId(999999999999);
  const late = store.newId(1000000000000);
  check(early < late, 'id 字典序 = 时间序（跨位数边界成立）');
  check(store.newId(1) < store.newId(1700000000000), '极小时间戳也排在前面（补零生效）');
  store.close(s);
}

/* ---------------------------------------------------------------- 3b. same-ms ordering
 * In its own database on purpose: appending to the same store as the previous case would
 * mix two very different timestamp ranges and make the assertion meaningless. */
{
  const { s } = fresh('same-ms');
  const t = 1_700_000_000_000;
  const c = store.appendMessage(s.db, { role: 'user', content: 'C', createdAt: t });
  const d = store.appendMessage(s.db, { role: 'user', content: 'D', createdAt: t });
  const e = store.appendMessage(s.db, { role: 'user', content: 'E', createdAt: t + 1 });
  const got = store.listMessages(s.db, { limit: 10 }).map((m) => m.content);
  check(got.join(',') === 'C,D,E', '同一毫秒内顺序仍确定：' + got.join(','));
  check(c.id < d.id, '同毫秒 id 仍递增（可排序）');
  store.close(s);
}

/* ---------------------------------------------------------------- 4. recent window */
{
  const { s } = fresh('recent');
  for (let i = 1; i <= 5; i++) {
    store.appendMessage(s.db, { role: 'user', content: 'm' + i, createdAt: 1000 + i });
  }
  const r = store.recentMessages(s.db, 3);
  check(r.map((m) => m.content).join(',') === 'm3,m4,m5',
    'recentMessages 取最后 N 条且按时间正序（给 API 的顺序）：' + r.map((m) => m.content).join(','));
  check(store.recentMessages(s.db, 0).length === 0, 'limit=0 返回空');
  store.close(s);
}

/* ---------------------------------------------------------------- 5. update in place */
{
  const { s } = fresh('update');
  const m = store.appendMessage(s.db, { role: 'assistant', content: '半句' });
  store.updateMessage(s.db, m.id, { content: '完整的一句', reasoning: '想过' });

  const after = store.recentMessages(s.db, 10)[0];
  check(after.content === '完整的一句', '更新后内容正确');
  check(after.reasoning === '想过', 'reasoning 已保存');

  const hits = store.searchMessages(s.db, '完整');
  check(hits.length === 1 && hits[0].id === m.id, '更新后全文索引同步（新内容可搜到）');
  const stale = store.searchMessages(s.db, '半句');
  check(stale.length === 0, '更新后旧内容不再命中（索引无残留）');

  check(store.updateMessage(s.db, 'no-such-id', { content: 'x' }) === null,
    '更新不存在的 id 返回 null 而不是抛错');
  store.close(s);
}

/* ---------------------------------------------------------------- 6. full-text search */
{
  const { s } = fresh('fts');
  store.appendMessage(s.db, { role: 'user', content: '我在做 HDD 这个终端项目' });
  store.appendMessage(s.db, { role: 'assistant', content: '主人，我记住了' });
  store.appendMessage(s.db, { role: 'user', content: '今天天气不错' });

  check(store.searchMessages(s.db, 'HDD').length === 1, '英文词检索命中 1 条');
  check(store.searchMessages(s.db, '终端').length === 1, '中文词检索命中 1 条');
  check(store.searchMessages(s.db, '不存在的词xyz').length === 0, '查不到时返回空数组');
  store.close(s);
}

/* ---------------------------------------------------------------- 7. identity meta */
{
  const { s } = fresh('identity');
  const id0 = store.ensureIdentity(s.db);
  check(id0.turns === 0, '初始轮数为 0');
  check(id0.firstSeen === 0, '尚未发生对话时 first_seen 为 0（打开库不算"首次见面"）');

  store.bumpTurns(s.db);          /* the first completed turn establishes first_seen */
  const id1 = store.ensureIdentity(s.db);
  check(id1.firstSeen > 0, '首个完成的回合写入 first_seen');
  check(id1.turns === 1, '轮数为 1');

  store.bumpTurns(s.db);
  const id2 = store.ensureIdentity(s.db);
  check(id2.turns === 2, '轮数累加到 2');
  check(id2.firstSeen === id1.firstSeen, 'first_seen 不被覆盖（只写一次）');
  check(typeof store.metaGet(s.db, 'last_seen') === 'string', 'last_seen 已更新');
  store.close(s);
}

/* ---------------------------------------------------------------- 8. downgrade guard */
{
  const { dir, s } = fresh('downgrade');
  s.db.exec('UPDATE schema_version SET version = 999');
  store.close(s);

  let threw = null;
  try { store.open({ dir }); } catch (e) { threw = e.message; }
  check(threw !== null && /newer than this build/.test(threw),
    '拒绝打开比本构建更新的库（防降级损坏）：' + (threw || '未抛错'));
}

/* ---------------------------------------------------------------- 9. migration is append-only */
{
  const dir = path.join(scratch, 'partial');
  fs.mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'hdd.db'));
  /* Simulate a v0 database: version 0, no tables. */
  db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
  db.exec('INSERT INTO schema_version (version) VALUES (0)');
  db.close();

  const s = store.open({ dir });
  check(s.schemaVersion === store.SCHEMA_VERSION, '从 v0 升级到最新成功');
  check(store.countMessages(s.db) === 0, '升级后 messages 表可用');
  store.close(s);
}

/* ---------------------------------------------------------------- 10. data dir resolution
 * The dev workflow relies on being able to redirect the store away from app/data, and on
 * resetDataDir refusing to delete unless explicitly forced. */
{
  const before = process.env.HDD_DATA_DIR;
  try {
    delete process.env.HDD_DATA_DIR;
    const dflt = store.getDataDir();
    check(dflt.endsWith(path.join('app', 'data')), '默认数据目录是 app/data：' + dflt);

    process.env.HDD_DATA_DIR = path.join(scratch, 'redirected');
    check(store.getDataDir() === path.join(scratch, 'redirected'),
      'HDD_DATA_DIR 覆盖默认目录');

    check(store.getDataDir({ dir: 'X:/explicit' }) === 'X:/explicit',
      '显式 dir 参数优先级最高');
  } finally {
    if (before === undefined) delete process.env.HDD_DATA_DIR;
    else process.env.HDD_DATA_DIR = before;
  }

  /* resetDataDir must be safe: a stray call without force must not delete anything. */
  const dir = path.join(scratch, 'reset');
  fs.mkdirSync(dir, { recursive: true });
  const s = store.open({ dir });
  store.appendMessage(s.db, { role: 'user', content: '不要删我' });
  store.close(s);

  check(fs.existsSync(path.join(dir, 'hdd.db')), 'reset 前数据库存在');

  let refused = null;
  try { store.resetDataDir(dir, {}); } catch (e) { refused = e.message; }
  check(refused !== null && /force/.test(refused), '不带 force 时拒绝删除：' + (refused || '未抛错'));
  check(fs.existsSync(path.join(dir, 'hdd.db')), '被拒绝后数据库仍然存在（数据未丢失）');

  const n = store.resetDataDir(dir, { force: true });
  check(n >= 1, '带 force 时删除了 ' + n + ' 个文件');
  check(!fs.existsSync(path.join(dir, 'hdd.db')), '重置后数据库已删除');
  check(fs.existsSync(dir), '只删文件，不删目录本身（目录可能被共用）');
}

/* ---------------------------------------------------------------- 11. topics
 * Migration 3 (ADR-006, ADR-012): the table, the nullable column, and the topic-scoped
 * queries that switching depends on. */
{
  const { dir, s } = fresh('topics');

  const tables = s.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  check(tables.includes('topics'), '迁移 3 建立了 topics 表');
  const cols = s.db.prepare('PRAGMA table_info(messages)').all().map((r) => r.name);
  check(cols.includes('topic_id'), 'messages 增加了 topic_id 列');

  const a = store.createTopic(s.db, { title: '终端项目' });
  check(/^\d{16}-\d{4}-[0-9a-f]{8}$/.test(a.id), '话题 id 与消息用同一种稳定 id：' + a.id);
  const b = store.createTopic(s.db, { title: '   ' });
  check(b.title === topics.FALLBACK_TITLE, '空标题回退为「' + topics.FALLBACK_TITLE + '」而不是空串');

  store.appendMessage(s.db, { role: 'user', content: '终端项目的第一句', topicId: a.id });
  store.appendMessage(s.db, { role: 'assistant', content: '终端项目的回答', topicId: a.id });
  store.appendMessage(s.db, { role: 'user', content: '电影话题的第一句', topicId: b.id });

  check(store.countMessages(s.db) === 3, '不传 topicId 时仍是全局计数');
  check(store.countMessages(s.db, { topicId: a.id }) === 2, '按话题计数只数该话题：' +
    store.countMessages(s.db, { topicId: a.id }));

  const scoped = store.recentMessages(s.db, 10, { topicId: a.id });
  check(scoped.length === 2, 'recentMessages 按话题过滤条数：' + scoped.length);
  check(scoped.every((m) => m.topicId === a.id), '返回的每条都属于该话题');
  check(!scoped.some((m) => /电影话题/.test(m.content)), '作用域内看不到别的话题的消息');
  check(store.recentMessages(s.db, 10).length === 3, '不传 topicId 时 recentMessages 仍是全覆盖');

  const listed = store.listMessages(s.db, { topicId: b.id });
  check(listed.length === 1 && listed[0].content === '电影话题的第一句',
    'listMessages 支持 topicId 过滤（ADR-001 里的 { topicId, limit } 形态）');

  check(store.lastMessageAt(s.db, b.id) > 0, 'lastMessageAt 报告该话题最新消息时间');
  check(store.lastMessageAt(s.db, 'no-such-topic') === 0, '空话题的 lastMessageAt 为 0（而不是 null）');

  /* Search must be narrowable too: the same word in two topics is the case that proves it. */
  store.appendMessage(s.db, { role: 'user', content: '搜索这个词的项目', topicId: a.id });
  store.appendMessage(s.db, { role: 'user', content: '搜索这个词的电影', topicId: b.id });
  check(store.searchMessages(s.db, '搜索这个词').length === 2, '搜索默认跨全部话题');
  const onlyA = store.searchMessages(s.db, '搜索这个词', 20, { topicId: a.id });
  check(onlyA.length === 1 && onlyA[0].topicId === a.id, '搜索可按话题收窄：' + onlyA.length);
  check(onlyA[0].topicTitle === '终端项目', '搜索结果带回话题标题：' + onlyA[0].topicTitle);

  /* Ordering: the topic most recently written to comes first, not the newest id. */
  const list = store.listTopics(s.db);
  check(list.length === 2, '列出两个话题');
  check(list[0].id === b.id, '最近有消息的话题排在最前（按 updated_at）');
  check(list.find((t) => t.id === a.id).messageCount === 3,
    '话题带消息计数：' + list.find((t) => t.id === a.id).messageCount);

  check(store.renameTopic(s.db, a.id, '  改过的名字  ').title === '改过的名字', '改名会去掉首尾空白');
  check(store.renameTopic(s.db, a.id, '   ') === null, '拒绝把标题改成空（否则列表里认不出来）');
  check(store.renameTopic(s.db, 'no-such-topic', 'x') === null, '改不存在的话题返回 null 而不是抛错');
  check(store.getTopic(s.db, a.id).title === '改过的名字', '改名已落盘');

  check(store.setCurrentTopic(s.db, a.id).id === a.id, '可以设置当前话题');
  check(store.getCurrentTopic(s.db).id === a.id, '当前话题已持久化');
  check(store.setCurrentTopic(s.db, 'no-such-topic') === null, '不能把不存在的话题设为当前');

  /* Moving a message between topics, used to repair a store by hand. */
  const moved = store.listMessages(s.db, { topicId: b.id, limit: 1 })[0];
  check(store.setMessageTopic(s.db, moved.id, a.id).topic_id === a.id, '可以把消息移到别的话题');
  check(store.countMessages(s.db, { topicId: b.id }) === 1, '移动后原话题少了一条');
  check(store.setMessageTopic(s.db, moved.id, 'no-such-topic') === null, '移到不存在的话题返回 null');

  store.close(s);

  /* The active topic is what a restart resumes, so it has to survive one. */
  const s2 = store.open({ dir });
  check(store.getCurrentTopic(s2.db).id === a.id, '当前话题跨重启保留');
  store.close(s2);
}

/* ---------------------------------------------------------------- 12. v0.1 upgrade
 * The promise ADR-006 made: adding topic_id later is an additive migration plus a backfill,
 * not a rewrite. The v2 database here is built from the SHIPPED migration SQL rather than
 * from a copy of it, so this test also fails if a shipped migration is ever edited. */
{
  const dir = path.join(scratch, 'upgrade');
  fs.mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'hdd.db'));
  db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
  db.exec('INSERT INTO schema_version (version) VALUES (0)');
  db.exec(store.MIGRATIONS[0][1]);   /* migration 1: messages + FTS + meta */
  db.exec(store.MIGRATIONS[1][1]);   /* migration 2: context_messages + prompt_chars */
  db.exec('UPDATE schema_version SET version = 2');
  const ins = db.prepare('INSERT INTO messages (id, role, content, created_at) VALUES (?,?,?,?)');
  ins.run('m1', 'user', 'v0.1 里说的第一句话', 1000);
  ins.run('m2', 'assistant', 'v0.1 里的回答', 1001);
  ins.run('m3', 'user', 'v0.1 里说的第二句话', 1002);
  db.close();

  const s = store.open({ dir });
  check(s.schemaVersion === store.SCHEMA_VERSION, 'v2 的库升级到 v' + store.SCHEMA_VERSION);

  const list = store.listTopics(s.db);
  check(list.length === 1, 'v0.1 的单条隐含会话回填成恰好一个话题：' + list.length);
  check(list[0].title === 'v0.1 里说的第一句话', '话题标题取自最早的用户消息：' + list[0].title);
  check(store.countMessages(s.db, { topicId: list[0].id }) === 3, '旧消息全部归入该话题');
  check(store.listMessages(s.db).every((m) => m.topicId === list[0].id),
    '升级后没有消息遗留 topic_id 为 NULL');
  check(store.getCurrentTopic(s.db).id === list[0].id, '回填出的话题成为当前话题');
  store.close(s);

  /* Idempotent: opening again must not re-segment or duplicate. */
  const s2 = store.open({ dir });
  check(store.countTopics(s2.db) === 1, '再次打开不会重复回填（幂等）');
  check(store.countMessages(s2.db) === 3, '重开后消息条数不变');
  store.close(s2);
}

/* ---------------------------------------------------------------- cleanup */
fs.rmSync(scratch, { recursive: true, force: true });
check(!fs.existsSync(scratch), '临时目录已清理');

console.log('\n' + (failed === 0 ? '数据层测试全部通过 ✓' : '数据层测试失败 ' + failed + ' 项'));
process.exit(failed === 0 ? 0 : 1);
