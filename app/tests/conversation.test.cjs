'use strict';
/*
 * conversation.test.cjs — conversation flow tests (plain Node, no Electron, no network).
 *
 * Exercises the piece ADR-001 puts in the main process: persist the user message,
 * assemble the prompt, persist the streamed reply. Run: node tests/conversation.test.cjs
 */
const fs = require('fs');
const path = require('path');
const store = require('../store.js');
const conv = require('../conversation.js');

let failed = 0;
function check(cond, msg) {
  if (cond) { console.log('PASS ' + msg); } else { console.log('FAIL ' + msg); failed++; }
}

const scratch = path.join(__dirname, '..', '.tmp-conv-test');
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });

const PERSONA = '你是 Fairy。禁止 emoji。禁止自称 DeepSeek。称呼用户为「主人」。';
const EXAMPLES = [
  ['Fairy，今天天气怎么样？', '主人，外面阳光明媚。'],
  ['帮我查一下现在几点了。', '主人，现在是凌晨两点十七分。'],
];

function open(name, extra) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  return conv.openConversation(Object.assign({ dir, persona: PERSONA, examples: EXAMPLES }, extra || {}));
}

/* Async since ADR-012 revision 1: a topic boundary may involve a request, so beginTurn is a
 * promise and every case below has to await it. */
(async () => {

/* ---------------------------------------------------------------- 1. opens and reports */
{
  const c = open('basic');
  check(c.available === true, '会话可用');
  check(typeof c.file === 'string' && c.file.endsWith('hdd.db'), '报告了数据库文件：' + c.file);
  check(c.schemaVersion === store.SCHEMA_VERSION, 'schema 版本正确');
  const id = c.identity();
  check(id && id.firstSeen === 0, '刚打开、还没有消息时不声称"首次见面"（firstSeen=0）');
  check(id.turns === 0, '初始轮数为 0');
  c.close();
}

/* ---------------------------------------------------------------- 2. degradation */
{
  /* Point the store at a path that cannot be a database file, to prove the app still
   * runs when persistence is unavailable (ADR-003). */
  const dir = path.join(scratch, 'broken');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hdd.db'), 'this is not a database');

  const c = conv.openConversation({ dir, persona: PERSONA, examples: EXAMPLES });
  check(c.available === false, '数据库损坏时不崩溃，标记为不可用');
  check(c.openError instanceof Error, '保留了错误对象供上层提示：' + (c.openError && c.openError.message).slice(0, 40));

  /* Everything must still be callable and must not throw. */
  const turn = await c.beginTurn('主人？');
  check(turn && typeof turn.turnId === 'string', '不可用时仍能开始回合（turnId 已生成）');
  check(c.recentHistory().length === 0, '不可用时历史为空数组');
  check(c.identity() === null, '不可用时身份为 null');
  check(c.messagesFor(turn).length === 2,
    '不可用时仍能组装消息（system + 本次提问）：' + c.messagesFor(turn).length);
  c.recordAssistantDelta(turn, '我在');
  c.finishTurn(turn, '我在');
  c.recordError(turn, '写入失败');
  check(true, '不可用时的所有写入均为安全的空操作，未抛错');
  c.close();
}

/* ---------------------------------------------------------------- 3. a full turn */
{
  const c = open('turn');
  const turn = await c.beginTurn('你是谁');
  check(c.recentHistory().length === 1, '用户消息已落盘（库里有 1 条）');
  check(turn.userMessageId && turn.userMessageId.length > 0, '记录了用户消息 id');
  check(turn.historyBefore.length === 0, 'historyBefore 是「这条消息之前」的历史（不含它本身）');

  const msgs = c.messagesFor(turn);
  check(msgs[0].role === 'system', '首条是 system');
  check(/Fairy/.test(msgs[0].content), 'system 含性格设定');
  check(/# 当前时间/.test(msgs[0].content), 'system 含当前时间');
  check(!/# 主人画像/.test(msgs[0].content), '第一轮还没有画像可注入（从未完成过回合）');

  /* Examples must NOT be injected as message pairs: the model would treat a sample answer
   * as something it actually said (this caused real off-topic replies). Only the system
   * prompt and the real history may be present — nothing else. */
  check(msgs.length === 2, '只有 system + 本次提问，没有伪造的对话轮次（共 ' + msgs.length + ' 条）');
  check(!msgs.some((m) => m.role !== 'system' && /今天天气|凌晨两点十七分/.test(m.content)),
    '示例文本未出现在任何非 system 消息里');
  /* The message being answered MUST be last. Its absence was a real bug: the model got a
   * conversation ending on the assistant's own previous reply and simply continued from
   * there, which looked exactly like "answering the previous question". */
  check(msgs[msgs.length - 1].role === 'user',
    '最后一条是用户消息（模型必须有事可答），实为 ' + msgs[msgs.length - 1].role);
  check(msgs[msgs.length - 1].content === '你是谁',
    '最后一条内容就是本次提问：' + JSON.stringify(msgs[msgs.length - 1].content));
  check(msgs.filter((m) => m.content === '你是谁').length === 1,
    '本次提问只出现一次（未与历史重复）');

  c.recordAssistantDelta(turn, '我是');
  const midId = turn.assistantMessageId;
  c.recordAssistantDelta(turn, '我是 Fairy');
  check(turn.assistantMessageId === midId, '流式过程中 assistant 行是就地更新，不重复插入');

  c.finishTurn(turn, '我是 Fairy，主人的首席助手。');
  check(c.recentHistory().length === 2, '一回合结束后库里有 2 条（用户 + 助手）');
  const id2 = c.identity();
  check(id2.turns === 1, '轮数累加到 1');
  c.close();

  /* Reopen: the conversation survived the restart. */
  const c2 = open('turn');
  const hist = c2.recentHistory();
  check(hist.length === 2, '重开后历史仍在：' + hist.length + ' 条');
  check(hist[1].content === '我是 Fairy，主人的首席助手。', '重开后内容完整：' + hist[1].content);
  check(c2.identity().turns === 1, '重开后轮数保留');

  const t2 = await c2.beginTurn('第二句');
  const msgs2 = c2.messagesFor(t2);
  check(/# 主人画像/.test(msgs2[0].content), '第二轮起注入主人画像');
  check(/第 2 轮对话/.test(msgs2[0].content), '画像里包含轮次：' + (msgs2[0].content.match(/第 \d+ 轮对话/) || [''])[0]);
  check(/# 首次见面/.test(msgs2[0].content) || /首次见面/.test(msgs2[0].content), '画像里包含首次见面时间');
  c2.close();
}

/* ---------------------------------------------------------------- 4. history grows */
{
  const c = open('grow');
  /* Six turns -> twelve messages, past EXAMPLE_HISTORY_LIMIT, so examples stop. */
  for (let i = 1; i <= 6; i++) {
    const t = await c.beginTurn('问题' + i);
    c.recordAssistantDelta(t, '回答' + i);
    c.finishTurn(t, '回答' + i);
  }
  const t = await c.beginTurn('最后一问');
  const msgs = c.messagesFor(t);
  check(msgs.length > 2, '历史较长时仍组装了上下文（共 ' + msgs.length + ' 条）');
  check(!/# 语气样例/.test(msgs[0].content),
    '历史超过阈值后不再注入语气样例（省 token）');
  check(msgs.some((m) => m.content === '回答6'), '最近的历史被带上（回答6）');
  check(c.identity().turns === 6, '六轮已计数：' + c.identity().turns);
  c.close();
}

/* ---------------------------------------------------------------- 5. errors are recorded
 * but excluded from the model's context. */
{
  const c = open('errors');
  const t = await c.beginTurn('触发一个错误');
  c.recordError(t, 'HTTP 500 boom');
  const hist = c.recentHistory();
  check(hist.length === 2, '错误也写进transcript（用户 + error）');
  check(hist.some((m) => m.role === 'error'), 'error 行已保存');

  const t2 = await c.beginTurn('再来');
  const msgs = c.messagesFor(t2);
  check(!msgs.some((m) => m.role === 'error'), 'error 行不进入 API 上下文');
  check(!msgs.some((m) => /boom/.test(m.content)), '错误文本不会被当作对话内容发给模型');
  c.close();
}

/* ---------------------------------------------------------------- 6. context window */
{
  const c = open('window');
  for (let i = 1; i <= 40; i++) {
    const t = await c.beginTurn('m' + i);
    c.finishTurn(t, 'a' + i);
  }
  const t = await c.beginTurn('latest');
  const msgs = c.messagesFor(t);
  /* system + at most CONTEXT_MESSAGE_LIMIT history entries + the current question.
   * No example pair at this size. */
  check(msgs.length <= 2 + conv.CONTEXT_MESSAGE_LIMIT,
    '上下文受 CONTEXT_MESSAGE_LIMIT 限制（' + msgs.length + ' <= ' + (2 + conv.CONTEXT_MESSAGE_LIMIT) + '）');
  check(msgs[0].role === 'system', 'system 仍在首位');
  check(msgs[msgs.length - 1].content === 'latest', '最后一条是本次提问');
  const lastHist = msgs.filter((m) => m.role === 'assistant').pop();
  check(lastHist && lastHist.content === 'a40', '窗口保留的是最近的助手回复：' + (lastHist && lastHist.content));
  check(!msgs.some((m) => m.content === 'a1'), '最旧的内容已被挤出窗口');
  c.close();
}

/* ---------------------------------------------------------------- 7. prompt assembly unit */
{
  const sys = conv.buildSystemPrompt(PERSONA, { firstSeen: Date.now(), turns: 5 }, Date.now());
  const personaAt = sys.indexOf('你是 Fairy');
  const capsAt = sys.indexOf('# 你能做什么');
  const profileAt = sys.indexOf('# 主人画像');
  const timeAt = sys.indexOf('# 当前时间');
  check(personaAt >= 0 && capsAt > personaAt && profileAt > capsAt && timeAt > profileAt,
    '拼装顺序为 性格 → 能力 → 画像 → 时间');

  const noProfile = conv.buildSystemPrompt(PERSONA, null, Date.now());
  check(noProfile.indexOf('# 主人画像') < 0, '无身份时不注入画像段落');

  const line = conv.profileLine({ firstSeen: Date.now(), turns: 0 });
  check(/首次见面/.test(line), 'profileLine 生成首次见面行');
  check(!/轮对话/.test(line), 'turns=0 时不声称轮次');
}

/* ---------------------------------------------------------------- 8. the real persona
 * Moved here from renderer.test.cjs: since ADR-001 the prompt is assembled in the main
 * process, so this is where its content can actually be asserted. */
{
  const real = require('../personality.js');
  const sys = conv.buildSystemPrompt(real.PERSONA, { firstSeen: Date.now(), turns: 3 }, Date.now());

  check(/Fairy/.test(sys), 'system prompt 包含身份 Fairy');
  check(/emoji/i.test(sys), 'system prompt 包含禁 emoji 指令');
  check(/DeepSeek/.test(sys), 'system prompt 禁止自称其它模型');
  check(/主人/.test(sys), 'system prompt 规定「主人」称呼');
  check(/说话规则/.test(sys), 'system prompt 含说话规则段');
  check(/\d{4}年\d{2}月\d{2}日 \d{2}:\d{2}/.test(sys), 'system prompt 含格式正确的当前时间');

  /* The persona is intentionally MINIMAL until v1.0. Guard the size so a rich character
   * cannot creep back in before the architecture behind it exists — a large persona made
   * her perform personality instead of answering questions. Raise this limit deliberately. */
  check(real.PERSONA.length < 900,
    'persona 保持精简（' + real.PERSONA.length + ' < 900 字符；完整性格留给 v1.0）');

  /* Capability facts live in capabilities.js, NOT in the persona (ADR-009, revised).
   *
   * Two earlier shapes were tried and both were caught in real conversations. First the
   * assertions looked for literal denial strings inside the persona — fossils that pinned
   * wording, in the file the persona is edited in, so a tone edit silently deleted a
   * guarantee. Then the prompt rendered the denials as a bulleted "cannot" list, and she read
   * it back to the user ("做不到的有：看摄像头、读硬件状态、替你操作电脑……"). Then the list
   * claimed to be complete, and she closed with "就这些".
   *
   * So: a short positive list, and nothing about what is missing. These assertions hold that
   * shape in place:
   *   1. every declared capability reached the prompt (guards the renderer),
   *   2. the block stays short, so an inventory cannot creep back in,
   *   3. no denial is rendered (that preference, as a regression guard),
   *   4. the persona states the manner rules and carries no capability facts,
   *   5. declarations that can be checked against the code still match the code.
   *
   * Fabrication itself is not something an assertion can establish — it is checked by
   * behaviour probes through the real assembly path. */
  const caps = require('../capabilities.js');
  check(/# 你能做什么/.test(sys), 'system prompt 含能力段（由 capabilities.js 渲染）');
  for (const entry of caps.CAN_DO) {
    check(sys.includes(entry.text), '能力段包含声明「' + entry.id + '」');
  }
  check(caps.capabilitySection().length < 200,
    '能力段保持精简（' + caps.capabilitySection().length + ' < 200 字符）');
  /* Scope this to the capability block, not the whole prompt: the persona quotes "就这些" in
   * order to forbid it, which the first version of this assertion tripped over. */
  check(!/全部能力|除以上之外|就这些/.test(caps.capabilitySection()),
    '能力段不声明"这是全部"（否则她会用「就这些」收尾）');
  check(/如实说做不到/.test(sys), '要求如实说明做不到，而非编造完成');

  /* Not rendering the denials is a requirement, not an accident. */
  for (const entry of caps.CANNOT_DO) {
    check(!sys.includes(entry.text),
      'prompt 未罗列做不到的项「' + entry.id + '」（避免她背清单）');
  }

  /* Manner rules live in the persona, where tone belongs. */
  check(/不要罗列做不到的项目/.test(real.PERSONA), '性格要求：被问能做什么时不罗列负面清单');
  check(/只说这一件做不到/.test(real.PERSONA), '性格要求：只说明当前这一件做不到');

  /* The split itself: capability facts must not creep back into the persona. */
  for (const entry of caps.CANNOT_DO) {
    check(!real.PERSONA.includes(entry.text),
      '性格文件里不出现能力事实「' + entry.id + '」（能力属于环境层）');
  }
  check(!/(没有摄像头|读不到硬件|工具调用|读写文件)/.test(real.PERSONA),
    '性格文件未复述任何能力事实');

  /* Cross-checks: a capability that exists in the code must be declared, and one that is
   * declared must exist. If a phase adds tools or opens the page's network access, these
   * fail until capabilities.js is updated — which is the point. Deriving capability
   * awareness from actual state only works if something notices when the state changes. */
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const sendsTools = /(^|[^.\w])tools\s*:/.test(mainSrc);
  const declaresTools = caps.ids(caps.CAN_DO).includes('tools');
  check(declaresTools === sendsTools,
    '「工具调用」的声明与 main.js 一致（main.js 发送 tools = ' + sendsTools + '，声明 = ' + declaresTools + '）');

  const liveSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'live.template.html'), 'utf8');
  const pageOffline = /connect-src\s+'none'/.test(liveSrc);
  check(pageOffline, '渲染层仍然没有网络访问（CSP connect-src none）');
  check(!caps.ids(caps.CAN_DO).includes('network'),
    '未把联网声明为能力（她不能替主人上网查东西）');

  /* Claims of imaginary powers must not appear as assertions. The phrasing below is used
   * in the persona only as a PROHIBITION ("do not fabricate ..."), so a naive substring
   * check would fire on the rule itself — test the sentence it sits in. */
  for (const claim of ['我连接了主人的摄像头', '能看到主人']) {
    check(!sys.includes(claim), 'prompt 未声称不存在的能力：' + claim);
  }
  const fabricated = /(已经为您做好了|已为您完成|已经帮您)/.exec(sys);
  if (fabricated) {
    const around = sys.slice(Math.max(0, fabricated.index - 20), fabricated.index + 20);
    check(/不要编造|绝不|禁止|不得/.test(around),
      '「' + fabricated[0] + '」只作为禁令出现，未作为声称：' + JSON.stringify(around));
  } else {
    check(true, 'persona 未出现任何「已完成」式声称');
  }

  /* No voice samples while the persona is minimal. buildMessages only injects them when
   * the pool is non-empty, so an empty pool must produce no sample section at all. */
  check(real.EXAMPLES.length === 0, '示例池为空（精简期不注入语气样例）');
  const msgs = conv.buildMessages({
    persona: real.PERSONA, examples: real.EXAMPLES,
    identity: { firstSeen: Date.now(), turns: 1 }, history: [], now: Date.now(),
  });
  check(!/# 语气样例/.test(msgs[0].content), '空的示例池不会产生样例段落');
  check(msgs.length === 1, '无历史时只发 system，不掺入任何伪造轮次');
}

/* ---------------------------------------------------------------- 9. what gets proposed
 * ADR-012 revision 1: the local rule no longer decides, it proposes — and a proposal costs one
 * request, so this table is about what is worth asking, not about what is true.
 *
 * It is deliberately tuned for recall. The replayed real transcript in
 * `docs/eval/topics-2026-09-14.json` is the authority on whether the recall is worth the
 * requests; this section only pins the boundary of the cheap path. */
{
  const t = require('../topics.js');
  const H = 60 * 60 * 1000;
  const at = 1_700_000_000_000;
  const propose = (recent, text, gapMs) => t.proposeBoundary({
    hasTopic: true,
    lastMessageAt: at - (gapMs == null ? 60000 : gapMs),
    now: at,
    text,
    recentTexts: recent,
  });

  check(t.proposeBoundary({ hasTopic: false, text: '你好' }).reason === 'first',
    '还没有话题时，第一条消息以 first 开话题（不是提议，是必须）');

  /* Messages that must NOT cost a request: interjections, and messages that plainly belong
   * where they are. The cheap path's job is to keep ordinary conversation free. */
  const cheap = [
    [['我今天很累'], '想早点睡', '短句接续'],
    [['我在做 HDD 这个终端项目', '主人，我记住了。'], '那个终端项目的数据库部分做得怎么样了', '共享主题词'],
    [['我在做 HDD 这个终端项目', '主人，我记住了。'], '嗯', '只有语气词'],
    [['我在做 HDD 这个终端项目', '主人，我记住了。'], '为什么？', '只有疑问词'],
    [['我在做 HDD 这个终端项目', '主人，我记住了。'], '哈哈哈', '只有笑声'],
    [['我们在讨论 SQLite FTS5 的 trigram tokenizer'], 'SQLite 的 FTS5 索引还需要重建吗', '英文主题词'],
  ];
  for (const [recent, text, why] of cheap) {
    const d = propose(recent, text);
    check(!d.propose, '不花请求（' + why + '）：' + text + ' -> ' + d.reason);
  }

  /* Messages that MUST be put to the confirmer. This list is the one that matters: being wrong
   * costs a request, not asking costs a subject. Everything below shares no vocabulary with the
   * current subject and carries enough content to be worth a question — including several that
   * the old rule "got right" by guessing, which is exactly what it could no longer be trusted
   * to do. */
  const proposals = [
    [['我在做 HDD 这个终端项目', '主人，我记住了，是一个终端界面。'], '给我推荐几部科幻电影吧', 'shift'],
    [['我们在聊 SQLite 的全文检索和分词', '主人，中文需要按字切分。'], '今晚吃什么好呢，冰箱里只有鸡蛋和西红柿', 'shift'],
    [['我们在讨论 SQLite FTS5 的 trigram tokenizer'], '推荐几家附近的川菜馆', 'shift'],
    [['我在做 HDD 这个终端项目', '主人，我记住了。'], '听说最近有一部新电影上映了，想去看', 'shift'],
    [['我在做 HDD 这个终端项目', '主人，我记住了。'], '我今天面试了一个新工作，有点紧张', 'idle'],
    [['我在做 HDD 这个终端项目', '主人，我记住了。'], '附近有什么好吃的', 'shift'],
    [['中文分词你是怎么处理的，为什么要一个字一个字切开', '我不做分词。文字先由 tokenizer 切成 token。'],
      '我想给这个软件再加点本事，让它能记住以前聊过的事情', 'shift'],
    /* These three the old rule resolved correctly on its own — a zero-overlap sentence that
     * continued the same subject. They are now questions rather than guesses, which is the
     * deliberate price of recall. */
    [['帮我想个名字'], '算了当我没说', 'shift'],
    [['我在做 HDD 这个终端项目', '主人，我记住了。'], '这个设计我觉得不太行', 'shift'],
    [['我在做 HDD 这个终端项目，数据库用的是 SQLite'], '这个项目我还想加一个搜索功能，你帮我看看', 'shift'],
    /* A single shared term among twelve is 0.083 coverage: below the bar, so it is asked about
     * rather than assumed. That is the deliberate cost of not guessing. */
    [['我在做 HDD 这个终端项目，数据库用的是 SQLite'], '这个项目我还想加一个搜索的本事', 'shift'],
    /* Coming back to the same subject after hours now gets asked too, because a long gap is
     * weaker evidence about the subject than a sentence in the middle of one. */
    [['我在做 HDD 这个终端项目', '主人，我记住了。'], '终端项目今天继续，我想加一个搜索功能', 'idle'],
  ];
  for (const [recent, text, reason] of proposals) {
    const gap = reason === 'idle' ? 8 * H : 60000;
    const d = propose(recent, text, gap);
    check(d.propose && d.reason === reason,
      '应该提议（' + reason + '）：' + text + ' -> ' + d.propose + '/' + d.reason);
  }

  check(!propose(['我在做 HDD 这个终端项目', '主人，我记住了。'], '在吗', 8 * H).propose,
    '隔了很久只说一句招呼也不提议（词项太少）');

  /* Derived titles: the fallback when no confirmer is available, and the seed of every title. */
  check(t.titleFromText('  给我推荐几部科幻电影吧  ') === '给我推荐几部科幻电影吧', '标题去掉首尾空白');
  check(t.titleFromText('「你在做什么」').length < 12, '标题去掉包裹的标点');
  const long = t.titleFromText('给我推荐几部科幻电影吧，最好是硬科幻那种，别太商业');
  check(long.length === t.TITLE_MAX_CHARS + 1 && long.endsWith('…'),
    '超长标题截断到 ' + t.TITLE_MAX_CHARS + ' 字加省略号：' + long);
  check(t.titleFromText('   ') === t.FALLBACK_TITLE, '空消息回退为「' + t.FALLBACK_TITLE + '」');
}

/* ---------------------------------------------------------------- 10. topics in the flow
 * The behaviour switching depends on: which topic a message lands in, what history that topic
 * gets, and what a switch changes. The clock is injected so the idle rule can be exercised
 * without waiting six hours.
 *
 * A confirmer is injected too, and its absence is itself a case (section 10b): since ADR-012
 * revision 1 a boundary is never opened on lexical evidence alone, so with nothing to confirm
 * it the whole feature has to fall back to one topic per sitting, quietly. */
function stubConfirmer(newOn, options) {
  const opts = options || {};
  const calls = [];
  const confirm = async (input) => {
    calls.push({ text: input.text, topicTitle: input.topic.title });
    if (opts.throwOn && input.text.includes(opts.throwOn)) throw new Error('classifier unreachable');
    if (opts.nullOn && input.text.includes(opts.nullOn)) return null;
    const isNew = newOn.some((s) => input.text.includes(s));
    return { isNew, title: isNew ? (opts.title || '由确认器命名的话题') : '' };
  };
  confirm.calls = calls;
  return confirm;
}

{
  let clock = 1_700_000_000_000;
  const confirmer = stubConfirmer(['科幻电影', '面试'], { title: '新话题' });
  const c = open('topic-flow', { now: () => clock, confirmBoundary: confirmer });

  const t1 = await c.beginTurn('我在做 HDD 这个终端项目，数据库用的是 SQLite');
  check(t1.topicReason === 'first', '第一条消息以 first 开话题：' + t1.topicReason);
  check(t1.topicConfirmed === null, '第一条消息没有提议可确认：' + t1.topicConfirmed);
  c.finishTurn(t1, '主人，我记住了。');
  const first = c.activeTopic();
  check(first && /终端项目/.test(first.title), '话题标题取自开头的消息：' + (first && first.title));
  check(first.titleLocked === true, '开头消息够长时标题直接定稿');

  clock += 60000;
  const t2 = await c.beginTurn('那个终端项目的数据库部分做得怎么样了');
  check(t2.topicId === first.id, '同一主题的第二条留在原话题');
  check(t2.historyBefore.length === 2, '它带上该话题自己的历史（2 条）：' + t2.historyBefore.length);
  check(confirmer.calls.length === 0, '不提议就不花请求：' + confirmer.calls.length);
  c.finishTurn(t2, '主人，已经写好了。');

  clock += 60000;
  const t3 = await c.beginTurn('给我推荐几部科幻电影吧，最好是硬科幻那种');
  check(t3.topicId !== first.id, '确认器同意之后才开出新话题');
  check(t3.topicReason === 'shift', '原因记为 shift：' + t3.topicReason);
  check(t3.topicConfirmed === true, '记录了这次是确认过的：' + t3.topicConfirmed);
  check(t3.historyBefore.length === 0,
    '新话题不带旧话题的历史（否则两个主题会混进同一个 prompt）');
  c.finishTurn(t3, '主人，我推荐这一部。');

  const topics = c.listTopics();
  check(topics.length === 2, '现在有两个话题：' + topics.length);
  check(topics[0].id === t3.topicId, '最近有消息的话题排在最前');
  check(topics[0].title === '新话题', '新话题用确认器给的名字，而不是截断的原句：' + topics[0].title);
  check(c.listHistory().every((m) => m.topicId === t3.topicId), 'listHistory 默认只给当前话题的消息');

  /* Switching is the whole point of topics: it changes both what is drawn and what is sent. */
  check(c.switchTopic(first.id) !== null, '可以切回旧话题');
  const hist = c.listHistory();
  check(hist.length === 4, '切回后重绘该话题的 4 条消息：' + hist.length);
  check(hist.every((m) => m.topicId === first.id), '重绘内容全部来自该话题');
  check(!hist.some((m) => /科幻电影/.test(m.content)), '重绘里没有另一个话题的消息');
  check(c.recentHistory().every((m) => m.topicId === first.id), 'recentHistory 也按当前话题收窄');

  clock += 60000;
  const t4 = await c.beginTurn('继续聊终端项目，我想加个搜索');
  check(t4.topicId === first.id, '切换之后的新消息写进切换后的那个话题');
  check(!t4.historyBefore.some((m) => /科幻电影/.test(m.content)),
    '发给模型的上下文里没有另一个话题的内容');
  c.finishTurn(t4, '主人，好的。');

  /* Hours of silence: a different subject starts a topic of its own. */
  clock += 8 * 60 * 60 * 1000;
  const t5 = await c.beginTurn('我今天面试了一个新工作，有点紧张');
  check(t5.topicId !== first.id && t5.topicReason === 'idle',
    '空闲很久之后换主题 -> ' + t5.topicReason);
  check(t5.topicConfirmed === true, '空闲那条也要确认过才开：' + t5.topicConfirmed);
  c.finishTurn(t5, '主人，别紧张。');

  /* Explicit /new. A manual topic must survive its own first message: an empty topic has no
   * subject to compare against, so running the proposer would abandon it immediately. */
  const manual = c.newTopic('手动开的话题');
  check(manual && manual.title === '手动开的话题', '可以手动开话题并切换过去');
  check(c.activeTopic().id === manual.id, '手动开的话题成为当前话题');
  const before = confirmer.calls.length;
  const t6 = await c.beginTurn('这个话题的第一句就写得长一点，免得被判定成换话题');
  check(t6.topicId === manual.id, '手动开的话题接住了下一条消息（空话题不会被自动放弃）');
  check(t6.topicReason === 'continue', '空话题里的第一条记录为 continue：' + t6.topicReason);
  check(confirmer.calls.length === before, '空话题里不做提议，也就不花请求');
  c.finishTurn(t6, '好。');

  check(c.renameTopic(manual.id, '改过的标题').title === '改过的标题', '可以改话题标题');
  check(c.renameTopic(null, '改当前话题').title === '改当前话题', '不传 id 时改的是当前话题');
  check(c.renameTopic(manual.id, '   ') === null, '拒绝改成空标题');

  const hits = c.search('终端');
  check(hits.length >= 1, '搜索跨话题找到内容：' + hits.length);
  check(hits.every((h) => h.topicTitle), '搜索结果带回话题标题，切过去之前就知道它在哪');
  const scoped = c.search('终端', { topicId: first.id });
  check(scoped.every((h) => h.topicId === first.id), '搜索可以限定在某个话题内');
  check(c.search('').length === 0, '空查询返回空数组（不需要调用方特判）');

  c.close();

  /* A restart resumes the topic that was in progress, not the newest one by id. */
  const c2 = open('topic-flow');
  check(c2.activeTopic() && c2.activeTopic().id === manual.id, '重启后回到上次所在的话题');
  c2.close();
}

/* ---------------------------------------------------------------- 10b. when nothing can confirm
 * The fallback is the part that must not go wrong: an unreachable classifier has to mean
 * "stay", because a classifier that cannot answer must not be able to invent boundaries. */
{
  let clock = 1_700_000_000_000;
  const c = open('no-confirmer', { now: () => clock });
  const t1 = await c.beginTurn('我在做 HDD 这个终端项目，数据库用的是 SQLite');
  c.finishTurn(t1, '主人，我记住了。');
  clock += 60000;
  const t2 = await c.beginTurn('给我推荐几部科幻电影吧，最好是硬科幻那种');
  check(t2.topicId === t1.topicId, '没有确认器时不拆话题（退化成一次会话一个话题）');
  check(t2.topicReason === 'shift' && t2.topicConfirmed === null,
    '仍然记录了"本该提议但没人确认"：' + t2.topicReason + '/' + t2.topicConfirmed);
  check(c.listTopics().length === 1, '确实只有一个话题：' + c.listTopics().length);
  c.close();

  const throwing = open('throw-confirmer', {
    now: () => clock,
    confirmBoundary: stubConfirmer([], { throwOn: '科幻电影' }),
  });
  const s1 = await throwing.beginTurn('我在做 HDD 这个终端项目，数据库用的是 SQLite');
  throwing.finishTurn(s1, '主人，我记住了。');
  clock += 60000;
  const s2 = await throwing.beginTurn('给我推荐几部科幻电影吧，最好是硬科幻那种');
  check(s2.topicId === s1.topicId, '确认器抛错时留在原话题，不中断回合');
  check(s2.topicReason === 'shift' && s2.topicConfirmed === null,
    '抛错等同于没有确认：' + s2.topicReason + '/' + s2.topicConfirmed);
  throwing.close();

  const silent = open('null-confirmer', {
    now: () => clock,
    confirmBoundary: stubConfirmer([], { nullOn: '科幻电影' }),
  });
  const n1 = await silent.beginTurn('我在做 HDD 这个终端项目，数据库用的是 SQLite');
  silent.finishTurn(n1, '主人，我记住了。');
  clock += 60000;
  const n2 = await silent.beginTurn('给我推荐几部科幻电影吧，最好是硬科幻那种');
  check(n2.topicId === n1.topicId, '确认器返回 null 时留在原话题');
  silent.close();
}

/* ---------------------------------------------------------------- 10c. provisional titles
 * A session that opens with "你好" must not be called 你好 forever, and the greeting itself
 * should end up inside the conversation it opened rather than beside it. */
{
  let clock = 1_700_000_000_000;
  const confirmer = stubConfirmer(['终端项目'], { title: 'HDD 终端项目' });
  const c = open('provisional-title', { now: () => clock, confirmBoundary: confirmer });

  const t1 = await c.beginTurn('你好');
  c.finishTurn(t1, '你好，主人。');
  const greeting = c.activeTopic();
  check(greeting.titleLocked === false, '招呼开的话题标题是暂定的：' + greeting.titleLocked);

  clock += 60000;
  const t2 = await c.beginTurn('我在做 HDD 这个终端项目，数据库用的是 SQLite');
  check(t2.topicId !== greeting.id, '真换话题时确认器同意，开出新话题');
  check(t2.topicConfirmed === true, '这次是确认过的');
  const after = c.activeTopic();
  check(after.title === 'HDD 终端项目', '新话题用确认器给的名字：' + after.title);
  check(c.listTopics().length === 1, '只有招呼的暂定话题被并进新话题，没有留下垃圾话题：' +
    c.listTopics().length);
  check(c.listHistory().some((m) => m.content === '你好'),
    '招呼那句话跟着进了新话题（它属于这次对话）');
  check(c.listHistory().every((m) => m.topicId === after.id), '两句话现在在同一个话题里');
  c.close();
}

/* ---------------------------------------------------------------- 11. naming rules
 * A provisional title is replaced by the first message substantial enough to name a subject,
 * and a title the user chose is never touched again. */
{
  let clock = 1_700_000_000_000;
  const c = open('title-rules', { now: () => clock });

  const t1 = await c.beginTurn('在吗');
  c.finishTurn(t1, '在的，主人。');
  const topic = c.activeTopic();
  check(topic.titleLocked === false, '「在吗」开的话题标题暂定');
  clock += 60000;
  const t2 = await c.beginTurn('我想聊聊终端项目里全文搜索的实现细节，索引是怎么建的');
  c.finishTurn(t2, '主人，我先说索引。');
  const renamed = c.activeTopic();
  check(renamed.id === topic.id, '没有提议时留在原话题');
  check(renamed.title !== '在吗' && /终端项目/.test(renamed.title),
    '暂定标题被第一条有内容的用户消息取代：' + renamed.title);
  check(renamed.titleLocked === true, '取代之后标题定稿，不再变动');

  const locked = c.renameTopic(null, '我自己起的名字');
  check(locked.title === '我自己起的名字' && locked.titleLocked === true, '用户改名会锁定标题');
  clock += 60000;
  const t3 = await c.beginTurn('继续说这个话题，我想知道中文分词是怎么处理的，按字还是按词');
  c.finishTurn(t3, '主人，是按字。');
  check(c.activeTopic().title === '我自己起的名字', '锁定后不会被后续消息改写：' + c.activeTopic().title);
  c.close();
}

/* ---------------------------------------------------------------- 12. the real transcript
 * ADR-010 asked for an evaluation set built from real conversations, and this is the first
 * entry: `docs/eval/topics-2026-09-14.json` is the conversation that broke the previous
 * version, kept verbatim, with a human judgement recorded for every turn.
 *
 * The judgement is replayed as the confirmer's answer, which is the only way to assert this
 * offline: what is under test is everything *except* the model's quality — which turns get
 * proposed, where messages land, what history each turn receives. The model's own answer is
 * the thing being evaluated, so it is data here, not an implementation detail. */
{
  const fsEval = require('fs');
  const evalPath = path.join(__dirname, '..', '..', 'docs', 'eval', 'topics-2026-09-14.json');
  check(fsEval.existsSync(evalPath), '评测语料存在：docs/eval/topics-2026-09-14.json');

  const corpus = JSON.parse(fsEval.readFileSync(evalPath, 'utf8'));
  check(Array.isArray(corpus.turns) && corpus.turns.length === 8,
    '语料包含全部 ' + corpus.turns.length + ' 个真实回合');

  /* The recorded judgement becomes the confirmer. */
  let turnIndex = -1;
  const judged = async () => {
    const expect = corpus.turns[turnIndex].expect;
    return { isNew: expect === 'new', title: expect === 'new' ? '由判定命名的话题' : '' };
  };
  const proposals = [];
  const confirmer = async (input) => {
    proposals.push(turnIndex);
    return judged();
  };

  let clock = new Date('2026-09-14T16:27:53').getTime();
  const c = open('real-transcript', { now: () => clock, confirmBoundary: confirmer });

  for (let i = 0; i < corpus.turns.length; i++) {
    turnIndex = i;
    const turn = corpus.turns[i];
    const t = await c.beginTurn(turn.user);
    check(t.topicConfirmed === null || typeof t.topicConfirmed === 'boolean',
      '回合 ' + (i + 1) + ' 记录了确认结果：' + t.topicConfirmed);
    c.finishTurn(t, turn.assistant);
    clock += 1000;
  }

  /* Recall: the turns where the local rule must spend a request, from the corpus. */
  check(JSON.stringify(proposals) === JSON.stringify(corpus.expectedProposals),
    '提议的回合与语料记录一致：' + JSON.stringify(proposals) +
    ' vs ' + JSON.stringify(corpus.expectedProposals));

  /* The layout: what the whole conversation collapses into. The previous version produced five
   * topics from these eight turns, four of them one project. Checked against the corpus rather
   * than against indices written here, so the data is the authority — including the greeting,
   * which must end up inside the project topic it opened. */
  const topics = c.listTopics();
  check(topics.length === corpus.expectedTopics.length,
    '整段对话收敛成 ' + corpus.expectedTopics.length + ' 个话题（旧版是 5 个）：' + topics.length);

  for (const group of corpus.expectedTopics) {
    const owners = group.turns.map((i) => {
      const row = c._store.db.prepare('SELECT topic_id FROM messages WHERE content = ? AND role = ?')
        .get(corpus.turns[i].user, 'user');
      return row ? row.topic_id : null;
    });
    check(owners.every((id) => id && id === owners[0]),
      '「' + group.title + '」的 ' + group.turns.length + ' 个回合最终落在同一个话题里（回合 ' +
      group.turns.join(',') + '）');
  }

  /* And no two of them may be the same topic, or the grouping above would be satisfied by
   * everything landing in one. */
  const groupIds = corpus.expectedTopics.map((group) => {
    const row = c._store.db.prepare('SELECT topic_id FROM messages WHERE content = ? AND role = ?')
      .get(corpus.turns[group.turns[0]].user, 'user');
    return row && row.topic_id;
  });
  check(new Set(groupIds).size === groupIds.length,
    '这几组话题互不相同：' + groupIds.length + ' 组 -> ' + new Set(groupIds).size + ' 个话题');

  c.close();
}

/* ---------------------------------------------------------------- cleanup */
fs.rmSync(scratch, { recursive: true, force: true });
check(!fs.existsSync(scratch), '临时目录已清理');

console.log('\n' + (failed === 0 ? '会话流程测试全部通过 ✓' : '会话流程测试失败 ' + failed + ' 项'));
process.exit(failed === 0 ? 0 : 1);

})().catch((e) => {

  console.error('FAIL: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
