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
  check(list[0].titleLocked === true,
    '回填出来的标题是定稿的（不能让后来的一句话给几百条历史改名）');
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

/* ---------------------------------------------------------------- 13. titles and absorption
 * Migration 4: a title is provisional until something earns the right to name the topic. The
 * rules exist because a session's first message is usually a greeting, and "你好" must not
 * become the permanent name of a conversation — nor block that greeting from being absorbed
 * into the subject that follows it. */
{
  const { s } = fresh('titles');

  const cols = s.db.prepare('PRAGMA table_info(topics)').all().map((r) => r.name);
  check(cols.includes('title_locked'), '迁移 4 给 topics 增加了 title_locked 列');

  const provisional = store.createTopic(s.db, { title: '你好' });
  check(provisional.titleLocked === false, '默认创建的标题是暂定的');
  const final = store.createTopic(s.db, { title: '终端项目', titleLocked: true });
  check(final.titleLocked === true, '可以创建时就定稿');

  check(store.retitleTopic(s.db, provisional.id, 'HDD 终端项目').title === 'HDD 终端项目',
    '暂定标题可以被替换');
  check(store.getTopic(s.db, provisional.id).titleLocked === true, '替换之后标题定稿');
  check(store.retitleTopic(s.db, provisional.id, '又改一次') === null,
    '定稿之后拒绝再次替换');
  check(store.getTopic(s.db, provisional.id).title === 'HDD 终端项目', '被拒绝后标题未变');

  /* The no-op case still locks: otherwise every later message would retry the same retitle. */
  const same = store.createTopic(s.db, { title: '同名' });
  check(store.retitleTopic(s.db, same.id, '同名') === null, '同名替换返回 null');
  check(store.getTopic(s.db, same.id).titleLocked === true, '同名替换也会定稿（避免每次重试）');

  check(store.renameTopic(s.db, final.id, '用户起的名字').titleLocked === true,
    '用户改名会锁定标题');
  check(store.retitleTopic(s.db, final.id, '不该生效') === null, '用户起的名字不会被改写');

  /* Absorption: the greeting goes with the conversation it opened. */
  const greeting = store.createTopic(s.db, { title: '在吗' });
  const subject = store.createTopic(s.db, { title: '项目讨论', titleLocked: true });
  store.appendMessage(s.db, { role: 'user', content: '在吗', topicId: greeting.id, createdAt: 1000 });
  store.appendMessage(s.db, { role: 'assistant', content: '在的。', topicId: greeting.id, createdAt: 1001 });
  store.appendMessage(s.db, { role: 'user', content: '聊聊项目', topicId: subject.id, createdAt: 1002 });

  const absorbed = store.absorbTopic(s.db, greeting.id, subject.id);
  check(absorbed && absorbed.moved === 2, '暂定话题的 2 条消息被移走：' + (absorbed && absorbed.moved));
  check(store.getTopic(s.db, greeting.id) === null, '空掉的暂定话题已删除');
  check(store.countMessages(s.db, { topicId: subject.id }) === 3, '消息全部归入目标话题');
  check(store.countMessages(s.db) === 3, '总条数不变（只是换了个话题）');
  check(store.absorbTopic(s.db, subject.id, subject.id) === null, '拒绝把话题并进自己');
  check(store.absorbTopic(s.db, final.id, subject.id) === null,
    '拒绝吞并一个已定稿的话题（那是用户看得见的名字）');
  check(store.getTopic(s.db, final.id) !== null, '被拒绝后原话题仍在');
  store.close(s);
}

/* ---------------------------------------------------------------- 14. memories (ADR-013)
 * Structured facts about the owner, each linked to the messages it came from. The row rules matter
 * more than the column list: nothing is overwritten, forgetting takes the whole chain with it, and
 * a memory can never be sourceless or point at a message that never existed. */
{
  const { s } = fresh('memories');

  const tables = s.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  check(tables.includes('memories'), '迁移 5 建立了 memories 表');
  check(tables.includes('memory_sources'), '迁移 5 建立了 memory_sources 表');
  const indexes = s.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
  check(indexes.includes('idx_memories_active'), '存在只覆盖活跃记忆的部分索引');

  const m1 = store.appendMessage(s.db, { role: 'user', content: '我在做 HDD 这个终端项目', createdAt: 1000 });
  const m2 = store.appendMessage(s.db, { role: 'user', content: '数据库用的是 node:sqlite', createdAt: 1001 });
  const m3 = store.appendMessage(s.db, { role: 'user', content: '我住在杭州', createdAt: 1002 });

  const a = store.createMemory(s.db, {
    text: '  主人在做 HDD 终端项目  ', createdAt: 2000, sourceMessageIds: [m1.id, m2.id],
  });
  check(a.text === '主人在做 HDD 终端项目', '记忆文本去掉首尾空白：' + JSON.stringify(a.text));
  check(a.active === true && a.supersededBy === null, '新记忆是活跃的');
  check(a.origin === 'inferred', '默认来源是推断：' + a.origin);
  check(store.countMemories(s.db) === 1, '活跃记忆计数为 1');

  const sources = store.memorySources(s.db, a.id);
  check(sources.length === 2, '一条记忆可以来自多条消息：' + sources.length);
  check(sources[0].content === '我在做 HDD 这个终端项目' && sources[1].content === '数据库用的是 node:sqlite',
    '来源按说出的顺序返回');
  check(store.memoriesFromMessage(s.db, m1.id).length === 1, '反向也能查：这条消息产生了 1 条记忆');

  /* Provenance is enforced, not hoped for. */
  let noText = null;
  try { store.createMemory(s.db, { text: '   ', sourceMessageIds: [m3.id] }); } catch (e) { noText = e.message; }
  check(noText !== null && /needs text/.test(noText), '拒绝空文本的记忆：' + noText);

  let ghostSource = null;
  try { store.createMemory(s.db, { text: '来自不存在的消息', sourceMessageIds: ['no-such-message'] }); }
  catch (e) { ghostSource = e.message; }
  check(ghostSource !== null && /FOREIGN KEY/.test(ghostSource),
    '拒绝指向不存在消息的来源：' + String(ghostSource).slice(0, 70));
  check(store.countMemories(s.db) === 1, '被拒绝之后没有留下半条记忆（事务回滚）');

  const b = store.createMemory(s.db, {
    text: '主人住在杭州', createdAt: 2001, origin: 'owner', sourceMessageIds: [m3.id],
  });
  check(b.origin === 'owner', '可以标记为主人自己说的：' + b.origin);

  /* Superseding: the old belief stays, marked rather than rewritten. */
  const c = store.supersedeMemory(s.db, a.id, {
    text: '主人在做 HDD 终端项目，用 node:sqlite', createdAt: 3000, sourceMessageIds: [m2.id],
  });
  const oldA = store.getMemory(s.db, a.id);
  check(oldA.active === false && oldA.supersededBy === c.id, '旧记忆被标记为已被取代，而不是被改写');
  check(oldA.text === '主人在做 HDD 终端项目', '旧记忆的原文仍然可读');
  check(oldA.supersededAt === 3000, '记录了被取代的时间');
  check(store.getMemory(s.db, c.id).active === true, '取代它的那条是活跃的');
  check(store.countMemories(s.db) === 2, '活跃记忆是 2 条（旧的已不计入）：' + store.countMemories(s.db));
  check(store.countMemories(s.db, { includeSuperseded: true }) === 3, '含被取代的共 3 条');
  check(store.listMemories(s.db).every((m) => m.active), '默认列表只给活跃记忆');
  check(store.listMemories(s.db, { includeSuperseded: true }).length === 3, '可以要求包含被取代的');
  check(store.activeMemories(s.db, 10).length === 2, '给 prompt 用的那份也只有活跃记忆');

  const chain = store.memoryChain(s.db, c.id);
  check(chain.length === 2 && chain[0].id === a.id && chain[1].id === c.id,
    '取代链可以完整回溯（旧 -> 新）');

  let twice = null;
  try { store.supersedeMemory(s.db, a.id, { text: '再改一次' }); } catch (e) { twice = e.message; }
  check(twice !== null && /already superseded/.test(twice), '拒绝重复取代同一条记忆：' + twice);
  check(store.supersedeMemory(s.db, 'no-such-memory', { text: 'x' }) === null,
    '取代不存在的记忆返回 null 而不是抛错');

  /* The rules the schema enforces by itself, so no code path has to remember them. */
  let halfMarked = null;
  try {
    s.db.prepare('INSERT INTO memories (id, text, created_at, superseded_by, superseded_at) VALUES (?,?,?,?,?)')
      .run('x1', 't', 1, c.id, null);
  } catch (e) { halfMarked = e.message; }
  check(halfMarked !== null, '拒绝"只标记了一半"的取代（两个字段必须同时有值）');

  let badOrigin = null;
  try {
    s.db.prepare('INSERT INTO memories (id, text, origin, created_at) VALUES (?,?,?,?)')
      .run('x2', 't', 'bogus', 1);
  } catch (e) { badOrigin = e.message; }
  check(badOrigin !== null, '拒绝未知的来源类型：' + String(badOrigin).slice(0, 50));

  /* Forgetting takes the chain, so nothing is resurrected and no pointer dangles. */
  const removed = store.forgetMemory(s.db, c.id);
  check(removed === 2, '忘记最新那条会一并带走它取代过的：' + removed);
  check(store.getMemory(s.db, c.id) === null && store.getMemory(s.db, a.id) === null, '整条链都已删除');
  check(store.countMemories(s.db, { includeSuperseded: true }) === 1, '只剩下与这条事实无关的记忆');
  check(store.memorySources(s.db, a.id).length === 0, '来源链接随记忆一起删除（无残留）');
  check(store.forgetMemory(s.db, 'no-such-memory') === 0, '忘记不存在的记忆返回 0，不抛错');

  /* Forgetting a middle row: the newer belief survives, and nothing points at the gap. */
  const d = store.createMemory(s.db, { text: '第一版', createdAt: 4000, sourceMessageIds: [m1.id] });
  const e = store.supersedeMemory(s.db, d.id, { text: '第二版', createdAt: 4001, sourceMessageIds: [m1.id] });
  const f = store.supersedeMemory(s.db, e.id, { text: '第三版', createdAt: 4002, sourceMessageIds: [m1.id] });
  check(store.memoryChain(s.db, f.id).length === 3, '三次取代形成一条三节的链');
  check(store.forgetMemory(s.db, e.id) === 2, '忘记中间那条会带走比它更早的两条');
  check(store.getMemory(s.db, f.id).active === true, '更新的那条仍然活跃，没有被牵连');
  check(store.getMemory(s.db, f.id).supersededBy === null, '它也没有留下指向已删除行的指针');
  check(store.memoryChain(s.db, f.id).length === 1, '取代链现在只剩它自己');
  store.close(s);
}

/* ---------------------------------------------------------------- cleanup */
fs.rmSync(scratch, { recursive: true, force: true });
check(!fs.existsSync(scratch), '临时目录已清理');

console.log('\n' + (failed === 0 ? '数据层测试全部通过 ✓' : '数据层测试失败 ' + failed + ' 项'));
process.exit(failed === 0 ? 0 : 1);
