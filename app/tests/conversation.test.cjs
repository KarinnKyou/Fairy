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
  const turn = c.beginTurn('主人？');
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
  const turn = c.beginTurn('你是谁');
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

  const t2 = c2.beginTurn('第二句');
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
    const t = c.beginTurn('问题' + i);
    c.recordAssistantDelta(t, '回答' + i);
    c.finishTurn(t, '回答' + i);
  }
  const t = c.beginTurn('最后一问');
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
  const t = c.beginTurn('触发一个错误');
  c.recordError(t, 'HTTP 500 boom');
  const hist = c.recentHistory();
  check(hist.length === 2, '错误也写进transcript（用户 + error）');
  check(hist.some((m) => m.role === 'error'), 'error 行已保存');

  const t2 = c.beginTurn('再来');
  const msgs = c.messagesFor(t2);
  check(!msgs.some((m) => m.role === 'error'), 'error 行不进入 API 上下文');
  check(!msgs.some((m) => /boom/.test(m.content)), '错误文本不会被当作对话内容发给模型');
  c.close();
}

/* ---------------------------------------------------------------- 6. context window */
{
  const c = open('window');
  for (let i = 1; i <= 40; i++) {
    const t = c.beginTurn('m' + i);
    c.finishTurn(t, 'a' + i);
  }
  const t = c.beginTurn('latest');
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
  const profileAt = sys.indexOf('# 主人画像');
  const timeAt = sys.indexOf('# 当前时间');
  check(personaAt >= 0 && profileAt > personaAt && timeAt > profileAt,
    '拼装顺序为 性格 → 画像 → 时间');

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

  /* The capability boundary is the one thing that must never be dropped: without it she
   * invents having done things. Check each denial is actually stated. */
  for (const denied of ['没有摄像头', '读不到硬件状态', '不能执行任何操作', '工具调用']) {
    check(sys.includes(denied), '明确否定能力「' + denied + '」');
  }
  check(/如实说做不到/.test(sys), '要求如实说明做不到，而非编造完成');
  /* Claims of imaginary powers must not appear as assertions. The phrasing below is used
   * in the persona only as a PROHIBITION ("do not fabricate ..."), so a naive substring
   * check would fire on the rule itself — test the sentence it sits in. */
  for (const claim of ['我连接了主人的摄像头', '能看到主人']) {
    check(!sys.includes(claim), 'persona 未声称不存在的能力：' + claim);
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

/* ---------------------------------------------------------------- cleanup */
fs.rmSync(scratch, { recursive: true, force: true });
check(!fs.existsSync(scratch), '临时目录已清理');

console.log('\n' + (failed === 0 ? '会话流程测试全部通过 ✓' : '会话流程测试失败 ' + failed + ' 项'));
process.exit(failed === 0 ? 0 : 1);
