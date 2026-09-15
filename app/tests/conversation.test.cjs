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

  /* Memory has its own two paths, and both have to be just as safe. */
  const memTurn = await c.rememberTurn(turn);
  check(memTurn.asked === false && memTurn.stored === 0, '存储不可用时抽取直接跳过');
  check(c.remember('随便一句') === null && c.forgetMemory('anything') === 0,
    '存储不可用时记忆的写入与删除都是安全空操作');
  check(c.memories().length === 0 && c.activeMemoryList(5).length === 0, '存储不可用时记忆列表为空');
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
  const sys = conv.buildSystemPrompt(PERSONA, { firstSeen: Date.now(), turns: 5 }, Date.now(),
    [{ text: '主人住在杭州' }]);
  const personaAt = sys.indexOf('你是 Fairy');
  const capsAt = sys.indexOf('# 你能做什么');
  const profileAt = sys.indexOf('# 主人画像');
  const memoryAt = sys.indexOf('# 关于主人的长期记忆');
  const timeAt = sys.indexOf('# 当前时间');
  check(personaAt >= 0 && capsAt > personaAt && profileAt > capsAt && memoryAt > profileAt &&
    timeAt > memoryAt, '拼装顺序为 性格 → 能力 → 画像 → 长期记忆 → 时间');

  const noProfile = conv.buildSystemPrompt(PERSONA, null, Date.now());
  check(noProfile.indexOf('# 主人画像') < 0, '无身份时不注入画像段落');
  check(noProfile.indexOf('# 关于主人的长期记忆') < 0, '没有记忆时不注入记忆段落');

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

  /* Phase 3's cross-check (ADR-013). The declaration and the machinery have to agree in both
   * directions: declaring a memory she does not have is a false claim, and having one that is not
   * declared is exactly the silent drift ADR-009 exists to prevent.
   *
   * The code side is checked by asking the prompt builder to assemble one, not by grepping for a
   * function name — a source-text match would keep passing after the injection stopped being
   * called. */
  const memoryDeclared = caps.ids(caps.CAN_DO).includes('memory');
  const withMemory = conv.buildSystemPrompt(real.PERSONA, null, Date.now(), [{ text: '主人住在杭州' }]);
  const promptCarriesMemory = /# 关于主人的长期记忆/.test(withMemory) && /主人住在杭州/.test(withMemory);
  check(memoryDeclared === promptCarriesMemory,
    '「记得以前的事」的声明与实际 prompt 一致（声明=' + memoryDeclared +
    '，prompt 能带上记忆=' + promptCarriesMemory + '）');

  const wiredExtractor = /(^|[^.\w])extractMemories\s*[:,]/.test(mainSrc);
  check(memoryDeclared === wiredExtractor,
    '声明的记忆能力与 main.js 的抽取接线一致（声明=' + memoryDeclared +
    '，接上抽取器=' + wiredExtractor + '）');

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
    [['今天天气不错，想出去走走'], '天气不错的话就去公园', '共享主题词（短句也走便宜路径）'],
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
   * costs a request, not asking costs a subject. Everything below is either too short or too
   * thinly connected to be trusted to the cheap path. */
  const proposals = [
    [['我在做 HDD 这个终端项目', '主人，我记住了，是一个终端界面。'], '给我推荐几部科幻电影吧', 'shift'],
    [['我们在聊 SQLite 的全文检索和分词', '主人，中文需要按字切分。'], '今晚吃什么好呢，冰箱里只有鸡蛋和西红柿', 'shift'],
    [['我们在讨论 SQLite FTS5 的 trigram tokenizer'], '推荐几家附近的川菜馆', 'shift'],
    [['我在做 HDD 这个终端项目', '主人，我记住了。'], '听说最近有一部新电影上映了，想去看', 'shift'],
    [['我在做 HDD 这个终端项目', '主人，我记住了。'], '我今天面试了一个新工作，有点紧张', 'idle'],
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
    /* The two the first production run got wrong, both now asked about. */
    [['你好', '主人好。有什么事？', '为我推荐一些电影吧', '可以，先给几部不同方向的。'],
      '附近有什么好吃的？', 'shift'],
    [['你好', '主人好。有什么事？', '为我推荐一些电影吧', '可以，先给几部不同方向的。'],
      '上学好烦啊', 'shift'],
  ];
  for (const [recent, text, reason] of proposals) {
    const gap = reason === 'idle' ? 8 * H : 60000;
    const d = propose(recent, text, gap);
    check(d.propose && d.reason === reason,
      '应该提议（' + reason + '）：' + text + ' -> ' + d.propose + '/' + d.reason);
  }

  /* One shared term is a coincidence, so a message needs two before it can pass unchallenged —
   * and that run's 「附近有什么好吃的？」 shared exactly one, 「有什」, with its topic. The case
   * above and this one are the same defect from both directions. */
  {
    const recent = ['你好', '主人好。有什么事？', '为我推荐一些电影吧', '可以，先给几部不同方向的。'];
    const terms = t.contentTerms('附近有什么好吃的？');
    const shared = t.sharedCount(terms, t.contentTerms(recent.join('\n')));
    check(shared === 1, '「附近有什么好吃的？」与话题只有 1 个词项重叠（「有什」）：' + shared);
    check(t.coverage(terms, t.contentTerms(recent.join('\n'))) > t.PROPOSE_COVERAGE,
      '而这一个词项的重叠率恰好越过了覆盖率门槛——正是它当初压住了提议');
    check(t.proposeBoundary({ hasTopic: true, lastMessageAt: at - 60000, now: at, text: '附近有什么好吃的？', recentTexts: recent }).propose,
      '共享词项不足 2 个时一律提议（两个毫无关系的字不该成为"同一话题"的证据）');
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
    /* A real answer carries a name either way: for the new topic, or for the current one. */
    return { isNew, title: isNew ? (opts.title || '由确认器命名的话题') : (opts.keptTitle || '') };
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

/* ---------------------------------------------------------------- 11b. naming on a "same" answer
 * The confirmation request happens anyway, so the model can name a topic it decided NOT to
 * split. Without this a session that opens with a greeting ends up titled after whatever
 * sentence happened to follow it — observed in a real run as a topic called
 * 「我在做 HDD 这个终端项目，数据库用的是内置的…」 while every other topic in the same store
 * carried a noun phrase. */
{
  let clock = 1_700_000_000_000;
  const confirmer = stubConfirmer([], { keptTitle: '终端项目' });
  const c = open('kept-naming', { now: () => clock, confirmBoundary: confirmer });

  const t1 = await c.beginTurn('你好');
  c.finishTurn(t1, '主人好。');
  check(c.activeTopic().title === '你好', '招呼先给话题一个暂定名：' + c.activeTopic().title);
  check(c.activeTopic().titleLocked === false, '这个暂定名还没定稿');

  clock += 60000;
  const t2 = await c.beginTurn('我在做 HDD 这个终端项目，数据库用的是内置的 node:sqlite');
  check(confirmer.calls.length === 1, '这条零重叠，问了一次：' + confirmer.calls.length);
  check(t2.topicId === t1.topicId, '模型答"没换"，所以留在原话题');
  check(t2.topicConfirmed === false, '记录为"问过、答没换"：' + t2.topicConfirmed);
  const named = c.activeTopic();
  check(named.title === '终端项目', '用模型给的名字，而不是截断的原句：' + named.title);
  check(named.titleLocked === true, '名字定稿');
  check(!/数据库用的是内置/.test(named.title), '不再是那句被截断的用户消息');
  c.close();

  /* No name from the model falls back to the message that arrived, exactly as before. */
  const fallback = open('kept-naming-fallback', {
    now: () => clock,
    confirmBoundary: stubConfirmer([], {}),
  });
  const f1 = await fallback.beginTurn('在吗');
  fallback.finishTurn(f1, '在的，主人。');
  clock += 60000;
  await fallback.beginTurn('我在做 HDD 这个终端项目，数据库用的是内置的 node:sqlite');
  check(fallback.activeTopic().titleLocked === true && /终端项目/.test(fallback.activeTopic().title),
    '模型没给名字时退回截断原句并定稿：' + fallback.activeTopic().title);
  fallback.close();

  /* And nothing unusable from the model may reach the topic list. */
  for (const junk of ['   ', '未命名话题', '…']) {
    const bad = open('kept-naming-junk-' + junk.length + junk.charCodeAt(0), {
      now: () => clock,
      confirmBoundary: stubConfirmer([], { keptTitle: junk }),
    });
    const b1 = await bad.beginTurn('你好');
    bad.finishTurn(b1, '主人好。');
    clock += 60000;
    await bad.beginTurn('我在做 HDD 这个终端项目，数据库用的是内置的 node:sqlite');
    const title = bad.activeTopic().title;
    check(title !== '未命名话题' && title !== '…' && /终端项目/.test(title),
      '模型给出不可用的名字（' + JSON.stringify(junk) + '）时改用截断原句：' + title);
    bad.close();
  }
}

/* ---------------------------------------------------------------- 12. the evaluation set
 * ADR-010 asked for an evaluation set built from real conversations, and every file in
 * `docs/eval/` is one: a conversation kept verbatim, with a human judgement recorded for each
 * turn. Adding a case is appending a turn and its `expect` — nothing in this file changes.
 *
 * The judgement is replayed as the confirmer's answer, which is the only way to assert this
 * offline: what is under test is everything *except* the model's quality — which turns get
 * proposed, where messages land, what history each turn receives. The model's own answer is the
 * thing being evaluated, so it is data here, not an implementation detail.
 *
 * The clock is synthetic (a minute per turn) rather than the recorded timestamps: both
 * transcripts run within minutes, far inside the idle threshold, so nothing depends on the
 * difference and the tests do not change behaviour with the calendar. */
{
  const evalDir = path.join(__dirname, '..', '..', 'docs', 'eval');
  const corpusFiles = fs.readdirSync(evalDir).filter((f) => f.endsWith('.json')).sort();
  check(corpusFiles.length >= 2, '评测语料至少两条真实对话：' + corpusFiles.join(', '));

  for (const file of corpusFiles) {
    const corpus = JSON.parse(fs.readFileSync(path.join(evalDir, file), 'utf8'));
    check(Array.isArray(corpus.turns) && corpus.turns.length > 0,
      file + '：包含 ' + (corpus.turns || []).length + ' 个真实回合');

    /* The recorded judgement becomes the confirmer, and the interval it was asked on is
     * recorded too: a turn that should have been asked about and was not is the failure this
     * whole corpus exists to catch. */
    let idx = -1;
    const proposals = [];
    const confirm = async () => {
      proposals.push(idx);
      const turn = corpus.turns[idx];
      const isNew = turn.expect === 'new';
      const observed = corpus.observedTitles ? corpus.observedTitles[String(idx)] : null;
      /* The name the real confirmer produced, where the run recorded one. */
      return { isNew, title: isNew ? (observed || '判定命名的话题') : '' };
    };

    let clock = 1_700_000_000_000;
    const c = open('eval-' + file.replace(/\.json$/, ''), {
      now: () => { clock += 60000; return clock; },
      confirmBoundary: confirm,
    });

    for (let i = 0; i < corpus.turns.length; i++) {
      idx = i;
      const turn = await c.beginTurn(corpus.turns[i].user);
      c.finishTurn(turn, corpus.turns[i].assistant);
    }

    check(JSON.stringify(proposals) === JSON.stringify(corpus.expectedProposals),
      file + '：提议的回合与语料记录一致 -> ' + JSON.stringify(proposals));

    /* Layout: what the conversation collapses into, against the corpus rather than against
     * indices written here, so the data is the authority. */
    const topics = c.listTopics();
    check(topics.length === corpus.expectedTopics.length,
      file + '：收敛成 ' + corpus.expectedTopics.length + ' 个话题，实得 ' + topics.length + ' 个：' +
      topics.map((t) => t.title).join(' / '));

    for (const group of corpus.expectedTopics) {
      const owners = group.turns.map((i) => {
        const row = c._store.db.prepare('SELECT topic_id FROM messages WHERE content = ? AND role = ?')
          .get(corpus.turns[i].user, 'user');
        return row ? row.topic_id : null;
      });
      check(owners.every((id) => id && id === owners[0]),
        file + '：「' + group.title + '」的 ' + group.turns.length + ' 个回合落在同一个话题里（回合 ' +
        group.turns.join(',') + '）');
    }

    /* And no two groups may share a topic, or the check above would be satisfied by everything
     * landing in one. */
    const groupIds = corpus.expectedTopics.map((group) => {
      const row = c._store.db.prepare('SELECT topic_id FROM messages WHERE content = ? AND role = ?')
        .get(corpus.turns[group.turns[0]].user, 'user');
      return row && row.topic_id;
    });
    check(new Set(groupIds).size === groupIds.length,
      file + '：这几组话题互不相同 -> ' + new Set(groupIds).size + ' 个话题');

    /* Where the model's own naming was observed, the topic must carry exactly that name. */
    for (const [turnIndex, title] of Object.entries(corpus.observedTitles || {})) {
      const row = c._store.db.prepare('SELECT topic_id FROM messages WHERE content = ? AND role = ?')
        .get(corpus.turns[Number(turnIndex)].user, 'user');
      const topic = row ? store.getTopic(c._store.db, row.topic_id) : null;
      check(topic && topic.title === title,
        file + '：模型给的名字被采用（回合 ' + turnIndex + ' -> 「' + title + '」）');
    }

    c.close();
  }
}

/* ---------------------------------------------------------------- 13. the memory trigger
 * ADR-013: the local rule decides *when* it is worth asking; the model decides *what* to remember.
 * So this section is only about the cue — the cost it spends and the cost it refuses to spend.
 *
 * It is deliberately blunt, and the bluntness is the point: an earlier draft matched phrasings
 * (我住在 / 我叫 / 我喜欢) and missed 我在做 HDD 这个终端项目, one of the most memorable things the
 * owner has said. Verb patterns are endless; first-person reference is not. */
{
  const memory = require('../memory.js');
  const ask = (text, turnsSinceAsk) => memory.shouldExtract({ text, turnsSinceAsk });

  /* Facts about the owner: short ones are the valuable ones, so the floor is low. */
  const disclosures = [
    '我叫小林', '我住在杭州', '我在做 HDD 这个终端项目', '我平时喜欢看科幻电影',
    '我对花生过敏', '我的生日是三月', '我养了一只猫', '我今年 30 岁', '我需要一个提醒功能',
  ];
  for (const text of disclosures) {
    const d = ask(text, 9);
    check(d.ask && d.reason === 'self', '自我介绍式的句子会被问一次：' + text + ' -> ' + d.reason);
  }

  /* Nothing about the owner, nothing asked. */
  const silent = ['今天天气不错', '那个终端项目怎么样了', '嗯', '为什么？', '把这句对话存成文件吧'];
  for (const text of silent) {
    const d = ask(text, 9);
    check(!d.ask, '与主人无关的句子不问：' + text + ' -> ' + d.reason);
  }

  /* Requests are what gets said to a terminal assistant most often, and the pronoun in them is an
   * object. Three of the four wrong firings on the first probe of this module were this shape. */
  const requests = ['帮我推荐几部电影吧', '你能帮我做什么', '给我推荐几部科幻电影', '让你久等了'];
  for (const text of requests) {
    const d = ask(text, 9);
    check(!d.ask, '请求里的「我」不算关于主人的事实：' + text + ' -> ' + d.reason);
  }

  /* And the over-fire that is kept on purpose, pinned here so it stays a decision rather than
   * becoming an accident: the second pronoun survives the request frame. Vetoing every
   * request-opening utterance would fix it and would also skip 帮我记一下我住在杭州. */
  check(ask('帮我看看我现在的表情', 9).ask,
    '已知且接受的误触发（请求里出现了第二个「我」）——代价是一次被浪费的请求');

  /* The cooldown is what bounds the cost, since the cue fires often by design. */
  check(!ask('我住在杭州', 0).ask && ask('我住在杭州', 0).reason === 'cooldown',
    '刚问过就不重复问');
  check(!ask('我住在杭州', memory.COOLDOWN_TURNS - 1).ask, '冷却期内不问');
  check(ask('我住在杭州', memory.COOLDOWN_TURNS).ask, '冷却期满可以再问');
  check(ask('我住在杭州', null).ask, '没有冷却信息时按可问处理（重启后最多多花一次请求）');

  /* A correction cuts through the cooldown: a belief the owner has just contradicted must not
   * queue behind a request already spent on something else. */
  for (const text of ['不对，我现在住上海', '我搬家了，现在住上海']) {
    const d = ask(text, 0);
    check(d.ask && d.reason === 'correction', '纠正类的话即使刚问过也要问：' + text + ' -> ' + d.reason);
  }
  check(!ask('不对', 0).ask, '只有纠正词、没有内容的短句不问（词项不足）');
}

/* ---------------------------------------------------------------- 14. the extractor's answer
 * The parser for what the extractor returns, and it sits in a module the tests can require rather
 * than in `main.js`, which cannot be loaded outside Electron — the reason ADR-012's boundary parser
 * has no coverage at all.
 *
 * The distinction that matters: `[]` is "readable, and there was nothing worth keeping", `null` is
 * "unusable". Nothing is stored on either, but only one of them means the extractor is broken. */
{
  const memory = require('../memory.js');
  const parse = (raw) => memory.parseExtraction(raw);

  const plain = parse('{"memories":[{"text":"主人在做 HDD 终端项目"}]}');
  check(plain && plain.length === 1 && plain[0].text === '主人在做 HDD 终端项目' && plain[0].replaces === null,
    '读出最普通的一种回答');

  const fenced = parse('好的，结果如下：\n```json\n{"memories":[{"text":"主人住在杭州"}]}\n```');
  check(fenced && fenced.length === 1 && fenced[0].text === '主人住在杭州',
    '模型把 JSON 包在散文和代码块里也能读出来');

  const withReplaces = parse('{"memories":[{"text":"主人住在上海","replaces":"mem-1"}]}');
  check(withReplaces && withReplaces[0].replaces === 'mem-1', '读得出它要取代哪一条记忆');

  check(JSON.stringify(parse('{"memories":[]}')) === '[]',
    '「没有值得记的」是一个合法回答，返回空数组而不是 null');
  check(parse('{"memories":[]}') !== null, '空数组与读不出来是两回事');

  /* Every unreadable shape points the same way: remember nothing. */
  for (const bad of ['', null, undefined, '抱歉，我无法完成', '{"memories":', '[1,2,3]', '{"facts":[]}', '不是 JSON']) {
    check(parse(bad) === null, '读不出来时返回 null（记住零条）：' + JSON.stringify(bad));
  }

  /* Entries that are structurally wrong are skipped, not fatal: one bad row must not lose the rest. */
  const mixed = parse('{"memories":[{"text":"主人住在杭州"},{"text":"   "},null,"字符串",{"notext":1},{"text":"主人喜欢科幻"}]}');
  check(mixed && mixed.length === 2, '跳过结构不对的条目，保留能用的：' + (mixed && mixed.length));
  check(mixed[0].text === '主人住在杭州' && mixed[1].text === '主人喜欢科幻', '保留的是两条正常的事实');

  /* A turn cannot flood the prompt. */
  const flood = parse(JSON.stringify({
    memories: Array.from({ length: 12 }, (_, i) => ({ text: '事实' + i + '号内容' })),
  }));
  check(flood.length === memory.MAX_PER_TURN, '一次最多接受 ' + memory.MAX_PER_TURN + ' 条：' + flood.length);

  /* A paragraph is refused rather than cut: truncating a statement can make it a different one. */
  const essay = parse(JSON.stringify({ memories: [{ text: '很长'.repeat(200) }] }));
  check(essay.length === 0, '过长的条目被拒绝，而不是被截断成另一句话');
  const justUnder = parse(JSON.stringify({ memories: [{ text: '好'.repeat(memory.MAX_TEXT_CHARS) }] }));
  check(justUnder.length === 1, '恰好在上限内的条目仍然接受');
}

/* ---------------------------------------------------------------- 15. the extraction path
 * ADR-013's other half: the trigger said yes, so now one request is spent and whatever comes back
 * becomes memories — or does not. Every failure mode here ends the same way, remembering nothing,
 * because an extractor that cannot answer must not be able to invent a fact about the owner. */
{
  let clock = 1_700_000_000_000;
  const calls = [];
  const errors = [];
  let answer = null;
  let unreachable = false;

  const extractor = async (input) => {
    calls.push(input);
    if (unreachable) throw new Error('extractor unreachable');
    return answer;
  };

  const c = open('memory-path', {
    now: () => clock,
    extractMemories: extractor,
    onMemoryError: (err) => errors.push(err),
  });

  /* Enough turns to expire the cooldown, using text the trigger always refuses, so no request is
   * spent getting to the next case. */
  const clearCooldown = async () => {
    for (let i = 0; i < require('../memory.js').COOLDOWN_TURNS; i++) {
      clock += 60000;
      const ft = await c.beginTurn('嗯');
      c.finishTurn(ft, '好。');
      await c.rememberTurn(ft);
    }
  };

  const t1 = await c.beginTurn('我住在杭州，在做 HDD 这个终端项目');
  c.finishTurn(t1, '主人，我记住了。');
  check(calls.length === 0, 'finishTurn 自己不发请求，抽取是单独一步');

  answer = '{"memories":[{"text":"主人住在杭州"},{"text":"主人在做 HDD 终端项目"}]}';
  const r1 = await c.rememberTurn(t1);
  check(r1.asked === true && r1.reason === 'self', '触发器同意才问这一次：' + r1.reason);
  check(calls.length === 1, '只发了一次抽取请求');
  check(calls[0].userText === '我住在杭州，在做 HDD 这个终端项目', '请求里带着主人的原话');
  check(calls[0].assistantText === '主人，我记住了。', '也带着这一轮的回答');
  check(Array.isArray(calls[0].existing), '并且带上已有的记忆，好让它认出「这是更新」');
  check(r1.stored === 2 && r1.superseded === 0, '存下两条记忆：' + r1.stored);

  const afterFirst = c.memories();
  check(afterFirst.length === 2 && afterFirst.every((m) => m.active), '两条都是活跃记忆');
  const linked = store.memorySources(c._store.db, afterFirst[0].id);
  check(linked.length === 2, '记忆链接到这一轮的两条消息：' + linked.length);
  check(linked.some((m) => m.role === 'user') && linked.some((m) => m.role === 'assistant'),
    '来源既包括主人的话，也包括那一轮的回答');

  /* Same topic again: the cooldown is what bounds the cost of a cue that fires often. */
  clock += 60000;
  const t2 = await c.beginTurn('我还想给这个项目加个搜索功能');
  c.finishTurn(t2, '好。');
  const r2 = await c.rememberTurn(t2);
  check(r2.asked === false && r2.reason === 'cooldown', '冷却期内不再问：' + r2.reason);
  check(calls.length === 1, '冷却期内没有产生新请求');

  /* A correction cuts through the cooldown and updates rather than duplicating. */
  clock += 60000;
  const t3 = await c.beginTurn('不对，我搬到上海了');
  c.finishTurn(t3, '好的。');
  const hangzhou = c.memories().filter((m) => /杭州/.test(m.text))[0];
  answer = JSON.stringify({ memories: [{ text: '主人住在上海', replaces: hangzhou.id }] });
  const r3 = await c.rememberTurn(t3);
  check(r3.asked === true && r3.reason === 'correction', '纠正类的话即使刚问过也要问：' + r3.reason);
  check(r3.superseded === 1 && r3.stored === 0, '它是取代而不是新增：superseded=' + r3.superseded);
  check(c.memories().length === 2, '活跃记忆仍是两条，没有变成三条');
  check(c.memories().some((m) => /上海/.test(m.text)), '新的住处在活跃列表里');
  const stale = store.getMemory(c._store.db, hangzhou.id);
  check(stale.active === false && stale.text === '主人住在杭州', '旧的住处被标记取代，原文仍可读');
  check(c.memories({ includeSuperseded: true }).length === 3, '含被取代的能看到三条');

  await clearCooldown();

  /* An id the model invented must not break the turn — and must not silently vanish either: it
   * becomes a new memory, visible in /memories, rather than a failed extraction. */
  clock += 60000;
  const t4 = await c.beginTurn('我平时喜欢看科幻电影');
  c.finishTurn(t4, '好。');
  answer = '{"memories":[{"text":"主人喜欢科幻电影","replaces":"no-such-memory"}]}';
  const r4 = await c.rememberTurn(t4);
  check(r4.stored === 1 && r4.superseded === 0 && r4.error === null,
    '指向不存在的 id 时按新增处理，不报错：stored=' + r4.stored);

  await clearCooldown();

  /* Every unreadable answer remembers nothing. */
  clock += 60000;
  const t5 = await c.beginTurn('我叫小林');
  c.finishTurn(t5, '记住了。');
  answer = '抱歉，我不确定该不该记';
  const r5 = await c.rememberTurn(t5);
  check(r5.asked === true && r5.stored === 0 && r5.error === null, '读不出来的回答等于没记住，也不算出错');

  await clearCooldown();

  /* A thrown request is reported, not raised into the turn. */
  clock += 60000;
  const t6 = await c.beginTurn('我养了一只猫');
  c.finishTurn(t6, '好。');
  unreachable = true;
  const r6 = await c.rememberTurn(t6);
  check(r6.asked === true && r6.stored === 0, '抽取失败时什么都不记');
  check(r6.error instanceof Error && errors.length === 1, '失败被上报给调用方，而不是抛出去');
  unreachable = false;

  /* Turns the trigger refuses never reach the extractor at all. */
  const before = calls.length;
  clock += 60000;
  const t7 = await c.beginTurn('今天天气不错');
  c.finishTurn(t7, '嗯。');
  const r7 = await c.rememberTurn(t7);
  check(r7.asked === false && r7.reason === 'nothing', '与主人无关的一轮不问：' + r7.reason);
  check(calls.length === before, '抽取器根本不会被调用');

  /* Enough turns later, the cooldown expires on its own. */
  await clearCooldown();
  clock += 60000;
  const t8 = await c.beginTurn('我也在学 Rust 了');
  c.finishTurn(t8, '好。');
  answer = '{"memories":[{"text":"主人在学 Rust"}]}';
  const r8 = await c.rememberTurn(t8);
  check(r8.asked === true && r8.reason === 'self', '冷却期满后会再问：' + r8.reason);
  check(r8.stored === 1, '而且这次真的存下了一条：' + r8.stored);

  /* /remember and /forget, the two things the owner controls directly. */
  const mine = c.remember('主人养了一只猫');
  check(mine && mine.origin === 'owner' && mine.active, '主人自己说的记忆标记为 owner 来源');
  check(store.memorySources(c._store.db, mine.id).length === 0,
    '直接说的记忆没有来源消息——来源就是主人自己');
  check(c.remember('   ') === null, '拒绝空的 /remember');
  const removed = c.forgetMemory(mine.id);
  check(removed === 1 && !c.memories().some((m) => m.id === mine.id), '忘记之后它不在列表里');
  check(c.forgetMemory('no-such-memory') === 0, '忘记不存在的记忆返回 0');
  c.close();

  /* With no extractor wired up at all — the default — the trigger still fires, and nothing is
   * stored and nothing throws. This is what the tests of every other section are running with. */
  const noExtractor = open('memory-no-extractor', { now: () => clock });
  const n1 = await noExtractor.beginTurn('我住在杭州');
  noExtractor.finishTurn(n1, '好。');
  const nr = await noExtractor.rememberTurn(n1);
  check(nr.asked === true && nr.stored === 0 && nr.error === null,
    '没有配置抽取器时：问了，但什么都没记，也没出错');
  check(noExtractor.memories().length === 0, '没有抽取器就不会有记忆');
  check(noExtractor.remember('主人住在杭州') !== null, '但 /remember 仍然可用（不依赖模型）');
  noExtractor.close();
}

/* ---------------------------------------------------------------- 16. what the prompt is told
 * Injection rules (ADR-013): active memories only, beside the profile, and bounded twice — by count
 * and by characters — because this section is in every single request and ADR-008 warns about the
 * prompt budget. */
{
  let clock = 1_700_000_000_000;
  const c = open('memory-inject', { now: () => clock });

  const t0 = await c.beginTurn('你好');
  c.finishTurn(t0, '主人好。');
  const bare = await c.beginTurn('在想点什么');
  const bareSys = c.messagesFor(bare)[0].content;
  check(!/# 关于主人的长期记忆/.test(bareSys), '一条记忆都没有时，不出现记忆段');
  c.finishTurn(bare, '嗯。');

  const older = c.remember('主人住在杭州');
  clock += 1000;
  const newer = c.remember('主人喜欢科幻电影');
  clock += 1000;
  const t1 = await c.beginTurn('随便说说');
  const sys1 = c.messagesFor(t1)[0].content;
  check(/# 关于主人的长期记忆/.test(sys1), '有记忆时出现记忆段');
  check(/主人住在杭州/.test(sys1) && /主人喜欢科幻电影/.test(sys1), '两条都在里面');
  check(sys1.indexOf('主人喜欢科幻电影') < sys1.indexOf('主人住在杭州'), '最新的记忆排在最前');
  check(sys1.indexOf('# 主人画像') < sys1.indexOf('# 关于主人的长期记忆') &&
    sys1.indexOf('# 关于主人的长期记忆') < sys1.indexOf('# 当前时间'),
    '记忆段夹在画像与当前时间之间');
  c.finishTurn(t1, '好。');

  /* A corrected belief stops being injected the moment it is superseded. */
  store.supersedeMemory(c._store.db, older.id, { text: '主人住在上海', createdAt: clock });
  clock += 1000;
  const t2 = await c.beginTurn('继续');
  const sys2 = c.messagesFor(t2)[0].content;
  check(/主人住在上海/.test(sys2) && !/主人住在杭州/.test(sys2),
    '被取代的记忆不再进入 prompt，取代它的那条进来');
  c.finishTurn(t2, '好。');
  c.close();

  /* Two ceilings. The count keeps the section from growing forever; the character ceiling is the
   * one that actually protects the budget, since a memory is a sentence, not a word.
   * Bullets are counted inside the memory section only — the capability and profile blocks are
   * bulleted too, and counting the whole prompt would have measured them by accident. */
  const memoryBullets = (prompt) => {
    const at = prompt.indexOf('# 关于主人的长期记忆');
    if (at < 0) return [];
    return prompt.slice(at).split('\n').filter((l) => l.startsWith('- '));
  };

  const counted = open('memory-count-cap', { now: () => clock });
  for (let i = 0; i < conv.MEMORY_INJECT_LIMIT + 15; i++) counted.remember('记忆条目' + i + '号');
  const ct = await counted.beginTurn('看看');
  const countBullets = memoryBullets(counted.messagesFor(ct)[0].content);
  check(countBullets.length === conv.MEMORY_INJECT_LIMIT,
    '按条数封顶：' + countBullets.length + ' 条（上限 ' + conv.MEMORY_INJECT_LIMIT + '）');
  counted.close();

  const sized = open('memory-char-cap', { now: () => clock });
  for (let i = 0; i < conv.MEMORY_INJECT_LIMIT; i++) sized.remember('第' + i + '条' + '内容'.repeat(50));
  const st = await sized.beginTurn('看看');
  const sizeBullets = memoryBullets(sized.messagesFor(st)[0].content);
  const body = sizeBullets.join('\n');
  check(body.length <= conv.MEMORY_SECTION_MAX_CHARS,
    '按字符封顶：' + body.length + ' <= ' + conv.MEMORY_SECTION_MAX_CHARS);
  check(sizeBullets.length < conv.MEMORY_INJECT_LIMIT,
    '字符上限真的起了作用（没有把 ' + conv.MEMORY_INJECT_LIMIT + ' 条全塞进去）：' + sizeBullets.length);
  sized.close();

  /* Empty text cannot produce an empty bullet. */
  check(conv.memorySection([{ text: '   ' }]) === '', '空白记忆不产生条目');
  check(conv.memorySection([]) === '' && conv.memorySection(null) === '', '没有记忆时返回空字符串');
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
