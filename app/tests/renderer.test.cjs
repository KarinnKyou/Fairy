'use strict';
/*
 * renderer.test.cjs — display-layer regression tests (jsdom; no Electron, no network).
 *
 * Since ADR-001 the renderer holds no authoritative state and builds no prompt: it paints
 * the transcript and sends one message at a time. Prompt assembly (persona, profile,
 * history, few-shot examples) is covered by tests/conversation.test.cjs instead.
 *
 * Covered here: layout and fade mask invariants, no bubbles/prompt text, history repaint
 * on startup, sending exactly the typed text, emoji stripping, typewriter, state machine.
 *
 * Run: node tests/renderer.test.cjs
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'www', 'live.html'), 'utf8');

let streamCb = null;
let askCalls = [];
let lastId = null;
/* Transcript the main process would return on startup. Set before the DOM is built. */
let historyRows = [
  { id: '1', role: 'user', content: '上次说过的话' },
  { id: '2', role: 'assistant', content: '主人，我记得。' },
];

const fakeApi = {
  getConfig: () => Promise.resolve({ configured: true, model: 'deepseek-v4-flash' }),
  listHistory: () => Promise.resolve(historyRows.slice()),
  /* The real contract: one user message, not a whole history. */
  ask: (text, id) => { askCalls.push({ text, id }); lastId = id; },
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

  // --- Startup: the stored transcript is repainted, and the renderer builds no prompt ---
  // historyRows was set before the DOM was created; restoreHistory() runs on startup.
  {
    const painted = [...out.querySelectorAll('.line')].map((n) => n.textContent);
    if (!painted.some((t) => t.includes('上次说过的话'))) {
      throw new Error('启动时未重绘历史记录，实际绘制了: ' + JSON.stringify(painted));
    }
    if (!painted.some((t) => t.startsWith('> '))) {
      throw new Error('历史里的用户消息缺少终端提示符前缀');
    }
    console.log('PASS 启动时重绘历史记录（用户行 + 助手行）');
  }

  // The renderer must not assemble a prompt any more (ADR-001).
  if (/var PERSONA\s*=/.test(html)) throw new Error('渲染层仍内嵌 PERSONA（prompt 应归主进程）');
  if (/function systemPrompt\s*\(/.test(html)) throw new Error('渲染层仍在组装 system prompt');
  if (/var history\s*=\s*\[/.test(html)) throw new Error('渲染层仍维护自己的 history');

  // --- Send: exactly the typed text, and nothing else ---
  input.value = '你是谁';
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(60);
  if (askCalls.length !== 1) throw new Error('api.ask 未被调用');
  if (askCalls[0].text !== '你是谁') {
    throw new Error('发送的不是原始文本，而是: ' + JSON.stringify(askCalls[0].text).slice(0, 80));
  }
  if (typeof askCalls[0].id !== 'string' || !askCalls[0].id) throw new Error('缺少回合 id');
  if (askCalls[0].messages !== undefined) throw new Error('仍在向主进程发送整份 messages');
  {
    const painted = [...out.querySelectorAll('.line.in')].map((n) => n.textContent);
    if (!painted.some((t) => t === '> 你是谁')) {
      throw new Error('发送后未在终端回显，实际: ' + JSON.stringify(painted));
    }
  }
  console.log('PASS 发送单条文本（不再传整份 messages，且已回显）');

  console.log('PASS 发送回显 + 会话由主进程接管（渲染层不再组装 prompt）');

  // The restored history is already on screen, so later assertions must look only at the
  // assistant lines produced by this turn, not at every assistant line in the window.
  const restoredCount = out.querySelectorAll('.line.assistant').length;
  const liveAssistant = () =>
    [...out.querySelectorAll('.line.assistant')].slice(restoredCount).map((n) => n.textContent).join('');

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
  const partial = liveAssistant();
  if (partial.length === 0) throw new Error('打字机尚未输出任何字符');
  if (!expectFull.startsWith(partial)) throw new Error('打字机前缀异常: ' + JSON.stringify(partial));
  if (partial.length >= expectFull.length) throw new Error('打字机一次性输出过多（不是逐字）: ' + JSON.stringify(partial));
  console.log('PASS 安慰态 + 逐字打字中（当前前缀=' + JSON.stringify(partial) + '）');

  // --- finish: full text, emoji stripped, back to idle ---
  await emit('content', chunk2);
  await emit('done');
  await waitFor(() => !input.disabled && mascot.getAttribute('data-state') === null, 6000, '回常态');
  await waitFor(() => {
    const t = liveAssistant();
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
