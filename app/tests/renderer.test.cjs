'use strict';
/*
 * renderer.test.cjs — terminal UI regression tests (jsdom; no Electron, no network).
 * Covers: centred mascot + fade mask, no bubbles/prompts, persona system prompt,
 * emoji stripping, typewriter output, thinking/speaking state switching.
 * Run: node tests/renderer.test.cjs
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'www', 'live.html'), 'utf8');

let streamCb = null;
let askCalls = [];
let lastId = null;

const fakeApi = {
  getConfig: () => Promise.resolve({ configured: true, model: 'deepseek-v4-flash' }),
  ask: (messages, id) => { askCalls.push({ messages, id }); lastId = id; },
  onStream: (cb) => { streamCb = cb; return () => { streamCb = null; }; },
};

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'file:///live.html',
  beforeParse(window) {
    window.fairyApp = fakeApi;
    window.matchMedia = (query) => ({
      matches: false, media: query,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {},
    });
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return;
    await sleep(25);
  }
  throw new Error('超时等待: ' + (what || '条件'));
}
async function emit(type, text) {
  streamCb({ type, id: lastId, text: text || '' });
  await sleep(20);
}

(async () => {
  const doc = dom.window.document;
  const input = doc.getElementById('term-input');
  const mascot = doc.getElementById('mascot');
  const out = doc.getElementById('out');

  // --- Static assertions: layout and UI ---
  if (!html.includes('translate(-50%, -50%)')) throw new Error('Fairy 未居中（无 translate(-50%,-50%)）');
  if (!html.includes('#stage')) throw new Error('缺少 #stage');
  if (!html.includes('mask-image')) throw new Error('缺少 mask-image');
  // Fade mask must stay the centred ellipse: assert the centre and half-axes, not
  // merely that some mask exists. A rectangular variant was tried and reverted.
  {
    const mask = /#out\s*\{[\s\S]*?mask-image:\s*(radial-gradient\([^;]+\));/.exec(html);
    if (!mask) throw new Error('缺少 #out 的中央径向淡化遮罩');
    const m = mask[1];
    if (!/ellipse 78vmin 58vmin at 50% 46%/.test(m)) {
      throw new Error('椭圆遮罩的中心或半轴被改动：' + m.slice(0, 80));
    }
    if (/linear-gradient\(to bottom/.test(m)) {
      throw new Error('遮罩被改成了纵向线性渐变（当前应为椭圆径向）');
    }
    // Centre must be fully transparent, otherwise text covers the mascot.
    if (!/rgba\(0,0,0,0\) 0%,\s*rgba\(0,0,0,0\) 42%/.test(m)) {
      throw new Error('椭圆遮罩中心区未保持全透明');
    }
    if (!/#000 92%,\s*#000 100%\)$/.test(m.trim())) {
      throw new Error('椭圆遮罩外缘未保持全不透明');
    }
  }
  if (!html.includes('id="log"')) throw new Error('缺少底部锚定内容区 #log');
  if (!html.includes('margin-top: auto')) throw new Error('缺少底部锚定 margin-top:auto');
  if (!/z-index: 20/.test(html) || !/z-index: 5/.test(html)) throw new Error('层级 z-index 缺失');
  if (!/--fairy-weight:\s*400/.test(html)) throw new Error('缺少字重变量 --fairy-weight: 400');
  // Text stroke was removed entirely; nothing of it may come back.
  if (/-webkit-text-stroke\s*:/.test(html)) throw new Error('残留居中描边（webkit text stroke）');
  if (html.includes('--fairy-outline')) throw new Error('残留外描边变量 --fairy-outline');
  if (html.includes('@@FAIRY_OUTLINE_SHADOW@@')) throw new Error('残留外描边占位符（prep 未处理）');
  if (!/\.line\s*\{[^}]*text-shadow:\s*none/.test(html)) throw new Error('.line 应为 text-shadow: none');
  if (!/#term-input\s*\{[^}]*text-shadow:\s*none/.test(html)) throw new Error('#term-input 应为 text-shadow: none');
  if (/text-shadow:\s*[^n]/.test(html.replace(/text-shadow:\s*none/g, ''))) {
    throw new Error('仍有非 none 的 text-shadow 残留');
  }
  if (doc.getElementById('chat')) throw new Error('旧对话框仍在');
  if (doc.querySelectorAll('.msg').length) throw new Error('仍有气泡元素');
  const visibleText = out.textContent + ' ' + (input.getAttribute('placeholder') || '');
  if (visibleText.includes('与 Fairy 对话')) throw new Error('起始提示未删除');
  if (visibleText.includes('思考中') || visibleText.includes('回复中') || visibleText.includes('常态')) throw new Error('状态文字提示仍在');
  if (input.getAttribute('placeholder')) throw new Error('输入框仍有 placeholder');
  console.log('PASS Fairy 居中布局 + 渐隐蒙版 + 无气泡/文案/占位');

  await sleep(80);

  // --- Send + system prompt ---
  input.value = '你是谁';
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(60);
  if (askCalls.length !== 1) throw new Error('api.ask 未被调用');

  // Built as: system persona, then (only while the history is short) one example pair,
  // then the real history.
  const sent = askCalls[0].messages;
  const sys = sent[0];
  if (sys.role !== 'system' || !/Fairy/.test(sys.content)) throw new Error('缺少 Fairy 自我认知 system prompt');

  // Persona must carry the character, the anti-emoji rule and the identity constraint.
  if (!/emoji/i.test(sys.content)) throw new Error('system prompt 缺少禁 Emoji 指令');
  if (!/DeepSeek/.test(sys.content)) throw new Error('system prompt 未禁止自称其它模型');
  if (!/主人/.test(sys.content)) throw new Error('system prompt 缺少「主人」称呼设定');
  if (!/核心性格/.test(sys.content)) throw new Error('system prompt 缺少性格设定（personality.js 未注入？）');
  if (!/# 当前时间/.test(sys.content)) throw new Error('system prompt 缺少当前时间');
  if (!/\d{4}年\d{2}月\d{2}日 \d{2}:\d{2}/.test(sys.content)) {
    throw new Error('当前时间格式异常: ' + (sys.content.match(/# 当前时间[\s\S]{0,40}/) || [''])[0]);
  }

  // The persona must not claim abilities HDD does not have.
  // A loose "does the prompt mention a boundary somewhere" check is not enough: the
  // words 边界/无法 appear elsewhere in the persona, so any invented capability slips
  // through. Assert on the capability section itself plus the exact denial wording.
  const capIdx = sys.content.indexOf('能力边界');
  if (capIdx < 0) throw new Error('system prompt 缺少「能力边界」小节');
  const capEnd = sys.content.indexOf('\n# 说话规则', capIdx);
  const cap = sys.content.slice(capIdx, capEnd < 0 ? undefined : capEnd);
  for (const denied of ['没有摄像头', '无法读取硬件状态', '无法执行任何操作', '工具调用']) {
    if (!cap.includes(denied)) throw new Error('能力边界段落缺少对「' + denied + '」的否定');
  }
  // Claims of imaginary powers: forbidden outright, anywhere in the prompt.
  const fakeClaims = ['我连接了主人的摄像头', '能看到主人', '已经被我拉黑', '为您预订了'];
  for (const claim of fakeClaims) {
    if (sys.content.includes(claim)) throw new Error('persona 声称了不存在的能力: ' + claim);
  }

  // One example pair while the history is short, inserted right after the system prompt.
  if (sent.length < 3) throw new Error('未注入 few-shot 示例');
  if (sent[1].role !== 'user' || sent[2].role !== 'assistant') {
    throw new Error('few-shot 示例位置异常: ' + sent.slice(1, 3).map((m) => m.role).join(','));
  }
  if (sent[1].content === '你是谁') throw new Error('few-shot 示例与真实输入混淆');
  const last = sent[sent.length - 1];
  if (last.role !== 'user' || last.content !== '你是谁') throw new Error('真实输入未置于消息末尾');

  console.log('PASS 发送回显 + 性格 system prompt（性格设定 + 时间 + 能力边界 + few-shot 示例）');

  // --- reasoning -> thinking state ---
  await emit('reasoning', '思考片段');
  await waitFor(() => mascot.getAttribute('data-state') === 'thinking', 1000, '思考态');
  console.log('PASS reasoning → 思考态');

  // --- content -> comforting state, one character at a time ---
  const expectFull = '我是 Fairy，不是 DeepSeek。 有什么可以帮你？';
  const chunk1 = '我是 Fairy😊，不是 DeepSeek。';
  const chunk2 = ' 有什么可以帮你？🎉';
  await emit('content', chunk1);
  await waitFor(() => mascot.getAttribute('data-state') === 'comforting', 1500, '安慰态');
  await sleep(90); // ~20ms per char: only a short prefix should be out by now
  const partial = [...out.querySelectorAll('.line.assistant')].map((n) => n.textContent).join('');
  if (partial.length === 0) throw new Error('打字机尚未输出任何字符');
  if (!expectFull.startsWith(partial)) throw new Error('打字机前缀异常: ' + JSON.stringify(partial));
  if (partial.length >= expectFull.length) throw new Error('打字机一次性输出过多（不是逐字）: ' + JSON.stringify(partial));
  console.log('PASS 安慰态 + 逐字打字中（当前前缀=' + JSON.stringify(partial) + '）');

  // --- finish: full text, emoji stripped, back to idle ---
  await emit('content', chunk2);
  await emit('done');
  await waitFor(() => !input.disabled && mascot.getAttribute('data-state') === null, 6000, '回常态');
  await waitFor(() => {
    const t = [...out.querySelectorAll('.line.assistant')].map((n) => n.textContent).join('');
    return t === expectFull;
  }, 6000, '整句打完');
  const finalText = [...out.querySelectorAll('.line.assistant')].map((n) => n.textContent).join('');
  if (/[😊🎉]/.test(finalText)) throw new Error('Emoji 未被清除: ' + finalText);
  console.log('PASS done → 常态；逐字完成全文=' + JSON.stringify(finalText) + '（Emoji 清除）');

  // --- Font-weight override must exist with !important and high specificity ---
  // assets/css/fairy-hdd-theme.css forces `font-weight: 800 !important` onto every
  // element. The font ships a single weight (400, no fvar), so 800 makes Chromium
  // synthesize a fake bold that blurs CJK text. jsdom resolves the cascade by
  // document order rather than specificity, so it cannot verify that the override
  // actually wins at runtime; this only asserts the rule is present and shaped
  // correctly. Runtime behaviour must be checked in a real browser.
  {
    const rule = /#hdd-root\[data-dsh-fairy-visual\][^{]*\{[^}]*font-weight:\s*400\s*!important[^}]*\}/.exec(html);
    if (!rule) throw new Error('缺少字重覆盖规则（#hdd-root 高特异性 + font-weight:400 !important）');
    if (!html.includes('id="hdd-root"')) throw new Error('<html> 缺少 id="hdd-root"（字重覆盖依赖它抬特异性）');
    if (!/font-weight:\s*400\s*!important/.test(rule[0])) throw new Error('字重覆盖缺少 !important');
    if (!/#hdd-root\[data-dsh-fairy-visual\][\s\S]{0,200}#out\s*\*/.test(rule[0])) {
      throw new Error('字重覆盖未覆盖 #out 的全部后代（主题的 :where(*) 会命中每个元素）');
    }
    console.log('PASS 字重覆盖规则存在（#hdd-root 高特异性 + !important，覆盖 #out 全体后代）');
  }

  console.log('\n终端界面回归测试全部通过 ✓');
  dom.window.close();
  process.exit(0);
})().catch((e) => {
  console.error('FAIL: ' + e.message);
  dom.window.close();
  process.exit(1);
});
