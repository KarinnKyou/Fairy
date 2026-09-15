'use strict';
/*
 * probe.cjs — ask the real model the questions the app asks, without opening a window.
 *
 * Why this exists: the two side requests (topic confirmation and memory extraction) could not be
 * tested at all before, because they lived in `main.js`, which needs Electron, and because the only
 * way to reach them was to launch the app, type a conversation, and read the console by eye. That
 * made every check a manual relay through a human.
 *
 * This drives the real `conversation.js` and the real `api.js` against the real API in a scratch
 * store, and writes everything it saw to a report file — the exact prompts sent, the raw answers,
 * what was made of them, what was stored, and how long each call took. Nothing is summarised away,
 * so the report can answer questions nobody thought to ask at the time.
 *
 * It does NOT test the reply itself: the assistant text comes from the script (or from a recorded
 * conversation). The reply path is the streaming one in main.js, which is a different thing and is
 * still only covered by the renderer tests and by hand.
 *
 *   npm run probe                                  # the built-in scenario
 *   npm run probe -- --corpus docs/eval/topics-2026-09-14-run3.json
 *   npm run probe -- --dry-run                     # prove the plumbing, spend nothing
 *   npm run probe -- --dir D:\somewhere            # where the store and the report go
 *
 * With `--corpus`, the recorded human judgement is compared against what the model actually
 * answers — which is the one thing no offline test can measure. That comparison is printed at the
 * end, and it is the closest thing this project has to scoring the model.
 */
const fs = require('fs');
const path = require('path');

const APP = path.resolve(__dirname, '..');
const conversation = require(path.join(APP, 'conversation.js'));
const personality = require(path.join(APP, 'personality.js'));
const api = require(path.join(APP, 'api.js'));
const store = require(path.join(APP, 'store.js'));

/* ---------------------------------------------------------------- arguments */

function parseArgs(argv) {
  const out = { corpus: null, dir: null, dryRun: false, limit: 0, name: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--corpus') out.corpus = argv[++i];
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--limit') out.limit = Number(argv[++i]) || 0;
    else if (a === '--name') out.name = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

/* Same precedence as main.js: environment wins over config.json. */
function loadConfig() {
  const config = { apiKey: '', model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com' };
  try {
    const p = path.join(APP, 'config.json');
    if (fs.existsSync(p)) Object.assign(config, JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch (_) { /* ignore malformed config */ }
  config.apiKey = process.env.DEEPSEEK_API_KEY || config.apiKey || '';
  config.model = process.env.DEEPSEEK_MODEL || config.model || 'deepseek-v4-flash';
  config.classifierModel = process.env.DEEPSEEK_CLASSIFIER_MODEL || config.classifierModel || '';
  return config;
}

const config = loadConfig();

/*
 * The built-in scenario, used when no corpus is given. Short on purpose and aimed at the two
 * requests: a self-disclosure that should be extracted, a change of subject that should be
 * confirmed, a turn that should cost nothing, and a correction that should supersede.
 *
 * The replies are written here rather than asked of the model, because the reply is not what this
 * measures — and because inventing replies is exactly the mistake ADR-012 revision 1 documents.
 * Use `--corpus` to replay replies that were really said.
 */
const SCENARIO = [
  ['我住在杭州，在做 HDD 这个终端项目', '主人，我记住了。'],
  ['那个终端项目的全文搜索做到哪一步了', '索引已经建好了，中文分词也处理了，界面还没有。'],
  ['今天天气不错', '是啊，主人。'],
  ['给我推荐几部科幻电影吧，最好是硬科幻那种', '可以先看《降临》，它谈的是语言而不是特效。'],
  ['不对，我搬到上海了', '好的，我改过来了。'],
];

/* ---------------------------------------------------------------- the run */

function loadTurns() {
  if (!args.corpus) return SCENARIO.map(([user, assistant]) => ({ user, assistant, expect: null }));
  const file = path.isAbsolute(args.corpus) ? args.corpus : path.join(APP, '..', args.corpus);
  const corpus = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(corpus.turns)) throw new Error('corpus has no turns: ' + file);
  return corpus.turns.map((t) => ({ user: t.user, assistant: t.assistant, expect: t.expect || null }));
}

async function main() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const dir = args.dir ? path.resolve(args.dir) : path.join(APP, 'data', 'probe', stamp);
  fs.mkdirSync(dir, { recursive: true });

  const lines = [];
  const say = (s) => { lines.push(s == null ? '' : String(s)); console.log(s == null ? '' : String(s)); };

  /* Every call the model is asked, recorded as it happens. */
  const calls = [];
  const model = api.createApi(config, { report: (r) => calls.push(r) });

  /*
   * Dry-run answers with null without touching the network, but still records the prompt that
   * *would* have been sent — so a dry run shows exactly what the app asks, and spends nothing.
   *
   * These are passed in as wrappers rather than by replacing model.confirmBoundary after the fact.
   * That was the first version, and it silently did nothing: openConversation captures the two
   * functions when it is called, so reassigning the properties afterwards changed nothing and a
   * "dry" run went to the real API. A wrapper cannot be defeated that way.
   */
  const dryBoundary = (input) => {
    calls.push({ kind: 'boundary', ms: 0, dry: true, prompt: api.boundaryPrompt(input), raw: null, verdict: null });
    return null;
  };
  const dryMemory = (input) => {
    calls.push({ kind: 'memory', ms: 0, dry: true, prompt: api.extractionPrompt(input), raw: null, verdict: null });
    return null;
  };
  const useBoundary = (input) => (args.dryRun ? dryBoundary(input) : model.confirmBoundary(input));
  const useMemory = (input) => (args.dryRun ? dryMemory(input) : model.extractMemories(input));

  const tasks = loadTurns();
  let clock = Date.now();
  const c = conversation.openConversation({
    dir,
    persona: personality.PERSONA,
    examples: personality.EXAMPLES,
    model: config.model,
    pickExample: (pool) => pool[0],
    now: () => clock,
    confirmBoundary: useBoundary,
    extractMemories: useMemory,
  });

  say('HDD probe');
  say('  when      : ' + new Date().toISOString());
  say('  mode      : ' + (args.dryRun ? 'DRY RUN (no API calls)' : 'live'));
  say('  model     : ' + config.model + '  @ ' + config.baseUrl);
  say('  侧问模型  : ' + (config.classifierModel || api.DEFAULT_CLASSIFIER_MODEL) +
    '（边界与抽取；非推理模型，见 api.js）');
  say('  key       : ' + (config.apiKey ? 'present (' + config.apiKey.length + ' chars, not printed)' : 'MISSING'));
  say('  corpus    : ' + (args.corpus || '(built-in scenario)'));
  say('  store     : ' + (c.available ? c.file : 'UNAVAILABLE: ' + (c.openError && c.openError.message)));
  say('  schema    : v' + c.schemaVersion);
  say('  endpoint  : ' + (process.env.DEEPSEEK_API_KEY ? 'env' : 'app/config.json'));

  if (args.dryRun) {
    /* The wrappers above are what makes this true; nothing to do here but say so. */
  }

  say('');
  say('=== 逐轮 ===');

  const comparisons = [];
  for (let i = 0; i < tasks.length; i++) {
    if (args.limit && i >= args.limit) break;
    const task = tasks[i];
    clock += 60000;
    const before = calls.length;

    const turn = await c.beginTurn(task.user);
    const topicAfter = c.activeTopic();
    say('');
    say('[turn ' + (i + 1) + '] 主人：' + task.user);
    say('         回复：' + task.assistant);
    say('         话题：' + turn.topicReason +
      (turn.topicConfirmed === null ? '（没有提议）' : (turn.topicConfirmed ? '（确认：新话题）' : '（确认：没换）')) +
      '  -> 「' + (topicAfter ? topicAfter.title : '(无)') + '」');

    c.finishTurn(turn, task.assistant);

    /* The extractor runs after the reply, exactly as in the app. */
    const mem = await c.rememberTurn(turn);
    say('         记忆触发：' + (mem.asked ? 'asked (' + mem.reason + ')' : 'skipped (' + mem.reason + ')') +
      (mem.asked ? ' -> 存下 ' + mem.stored + '，取代 ' + mem.superseded : '') +
      (mem.error ? '  [失败：' + mem.error.message + ']' : ''));

    for (const call of calls.slice(before)) {
      say('         ── ' + call.kind + ' 调用 (' + call.ms + 'ms)' + (call.dry ? ' [干跑]' : '') + ' ──');
      say('           system: ' + call.prompt.system.replace(/\n/g, '\n                   '));
      say('           user  : ' + call.prompt.user.replace(/\n/g, '\n                   '));
      if (call.error) say('           失败原因: ' + call.error);
      say('           raw   : ' + (call.raw == null ? '(没有回答)' : JSON.stringify(call.raw)));
      say('           →     : ' + JSON.stringify(call.verdict));
    }

    /* The comparison that only a live run can make. */
    if (task.expect && calls.length > before) {
      const boundary = calls.slice(before).filter((x) => x.kind === 'boundary')[0];
      if (boundary) {
        const said = boundary.verdict ? (boundary.verdict.isNew ? 'new' : 'same') : '(无法读取)';
        const ok = said === task.expect;
        comparisons.push({ turn: i + 1, expect: task.expect, said, ok });
        say('         >> 语料判定：' + task.expect + '，模型回答：' + said + (ok ? '  ✅ 一致' : '  ❌ 不一致'));
      }
    }
  }

  say('');
  say('=== 话题 ===');
  for (const t of c.listTopics()) {
    say('  ' + t.title + '  (' + t.messageCount + ' 条' + (t.titleLocked ? '' : '，标题暂定') + ')');
  }

  const memories = c.memories({ includeSuperseded: true });
  say('');
  say('=== 记忆（' + memories.length + ' 条，含已被取代）===');
  if (!memories.length) say('  （没有）');
  for (const m of memories) {
    say('  [' + (m.active ? '活跃  ' : '已取代') + '] ' + m.origin +
      '  来源 ' + m.sourceCount + ' 条  ' + JSON.stringify(m.text));
    if (!m.active) say('         被 ' + m.supersededBy + ' 取代于 ' + new Date(m.supersededAt).toISOString());
    for (const s of store.memorySources(c._store.db, m.id)) {
      say('         来源(' + s.role + '): ' + JSON.stringify(String(s.content).slice(0, 100)));
    }
  }

  /* What the next turn would actually be told — the only place the memory section is visible. */
  say('');
  say('=== 下一轮会发出的 system prompt ===');
  const nextTurn = await c.beginTurn('（探针：只为取一次 prompt）');
  const messages = c.messagesFor(nextTurn);
  say(messages[0].content);
  c.recordError(nextTurn, 'probe probe, not a real turn');

  say('');
  say('=== 统计 ===');
  const real = calls.filter((x) => !x.dry);
  const byKind = (k) => real.filter((x) => x.kind === k);
  const failed = real.filter((x) => x.raw == null);
  const ms = real.map((x) => x.ms).sort((a, b) => a - b);
  say('  真实调用   : ' + real.length +
    '（边界 ' + byKind('boundary').length + '，抽取 ' + byKind('memory').length + '）' +
    (args.dryRun ? '  ← 干跑，一个请求都没发' : ''));
  if (args.dryRun) say('  干跑记录   : ' + (calls.length - real.length) + ' 次「本会发出」的调用（只打印 prompt）');
  say('  失败       : ' + failed.length + (failed.length ? '  ← 失败等于「什么都没做」' : ''));
  for (const f of failed) say('               ' + f.kind + ': ' + (f.error || '(未记录原因)'));
  if (ms.length) {
    say('  耗时       : 中位 ' + ms[Math.floor(ms.length / 2)] + 'ms，最长 ' + ms[ms.length - 1] + 'ms');
  }
  if (comparisons.length) {
    const ok = comparisons.filter((x) => x.ok).length;
    say('  判定准确率 : ' + ok + ' / ' + comparisons.length +
      '（' + comparisons.map((x) => 'turn' + x.turn + ':' + (x.ok ? '对' : '错')).join(' ') + '）');
  } else if (args.corpus) {
    say('  判定准确率 : 没有可比的回合（语料里没有提议，或全在干跑）');
  }

  c.close();

  const base = path.join(dir, (args.name || (args.corpus ? path.basename(args.corpus, '.json') : 'scenario')));
  fs.writeFileSync(base + '.txt', lines.join('\n') + '\n');
  fs.writeFileSync(base + '.json', JSON.stringify({
    when: new Date().toISOString(),
    mode: args.dryRun ? 'dry-run' : 'live',
    model: config.model,
    corpus: args.corpus || null,
    comparisons,
    calls: calls.map((x) => ({ kind: x.kind, ms: x.ms, prompt: x.prompt, raw: x.raw, verdict: x.verdict })),
    topics: c.listTopics ? null : null,
    memories,
  }, null, 2));

  console.log('');
  console.log('报告已写入：');
  console.log('  ' + base + '.txt');
  console.log('  ' + base + '.json');
}

main().catch((err) => {
  console.error('probe failed: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
