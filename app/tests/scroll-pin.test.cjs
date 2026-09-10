'use strict';
/*
 * scroll-pin.test.cjs — the newest reply must stay visible above the input row.
 * Run: node tests/scroll-pin.test.cjs
 *
 * scrollBottom() bails out when the distance to the bottom exceeds 24px ("user
 * scrolled up"). Appending a line grows scrollHeight by ~one line (30px x 1.6 =
 * 48px) before scrollTop catches up, so the threshold treats every append as a
 * manual scroll and skips it; the offset accumulates (48/96/144...) and the
 * newest reply ends up off-screen. pinBottom() scrolls unconditionally instead.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'www', 'live.html'), 'utf8');

let failed = 0;
function check(cond, msg) {
  if (cond) { console.log('PASS ' + msg); } else { console.log('FAIL ' + msg); failed++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  /* ---------- Static assertions ----------
     These, not the behavioural assertions below, are what actually catch the bug:
     the size stub models layout growth synchronously (stub.h += LINE_H), whereas a
     real browser grows the layout after JS returns, and the drift is created inside
     that window. So the behavioural checks below still report zero drift even with
     the fix removed; their value is proving no regression once the fix is in place,
     not detecting its absence. */

  check(/function pinBottom\(\)/.test(html), '存在 pinBottom()（无条件贴底）');
  check(/log\.insertBefore\(el, inputRow\);\s*\r?\n\s*scrollBottom\(\);\s*\r?\n\s*pinBottom\(\);/.test(html),
    'lineEl 在插入新行后调用 pinBottom()');
  check(/textContent \+= ch;\s*\r?\n\s*scrollBottom\(\);\s*\r?\n\s*pinBottom\(\);/.test(html),
    '打字机 pump 每字后调用 pinBottom()');
  check(!/function pinBottom[\s\S]{0,300}?clientHeight > 24/.test(html),
    'pinBottom 内部不含阈值提前返回（否则偏差会累加）');

  /* ---------- Behavioural assertions ---------- */
  const OUT_H = 600;
  const LINE_H = 48;
  const stub = { h: OUT_H, top: 0 };

  let streamCb = null;
  let lastId = null;
  const fakeApi = {
    getConfig: () => Promise.resolve({ configured: true, model: 'deepseek-v4-flash' }),
    ask: (messages, id) => { lastId = id; },
    onStream: (cb) => { streamCb = cb; return () => { streamCb = null; }; },
  };

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'file:///live.html',
    beforeParse(window) {
      window.fairyApp = fakeApi;
      window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      /* Run rAF synchronously so the test needs no real frames. */
      window.requestAnimationFrame = (cb) => { cb(Date.now()); return 0; };
    },
  });

  const doc = dom.window.document;
  const out = doc.getElementById('out');
  const log = doc.getElementById('log');
  const input = doc.getElementById('term-input');

  Object.defineProperty(out, 'clientHeight', { get: () => OUT_H, configurable: true });
  Object.defineProperty(out, 'scrollHeight', { get: () => stub.h, configurable: true });
  Object.defineProperty(out, 'scrollTop', {
    get: () => stub.top,
    set: (v) => { stub.top = Math.max(0, Math.min(v, Math.max(0, stub.h - OUT_H))); },
    configurable: true,
  });

  await sleep(60);
  if (!streamCb) { console.log('FAIL 页面未订阅流事件，测试无法驱动'); process.exit(1); }

  /* Drive turns through the real interaction path (typing + Enter + stream events).
     Fixed sleeps are not enough: the typewriter emits one character at a time, so
     starting the next turn before the previous one settles is blocked by `busy` and
     silently drops turns. Wait for the turn to actually finish instead. */
  async function waitIdle(timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeoutMs || 6000)) {
      /* Finished once the input is enabled and the last assistant line stops growing. */
      if (!input.disabled) {
        const last = log.querySelector('.line.assistant:last-of-type');
        const t1 = last ? last.textContent : '';
        await sleep(60);
        const t2 = last ? (log.querySelector('.line.assistant:last-of-type') || {}).textContent : '';
        if (t1 === t2 && t1.length > 0) return true;
      }
      await sleep(40);
    }
    return false;
  }

  async function sendTurn(i) {
    input.value = '第 ' + i + ' 轮提问';
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    stub.h += LINE_H;                                   /* 用户行已追加 */
    await sleep(20);
    streamCb({ type: 'content', id: lastId, text: '第 ' + i + ' 轮回复内容' });
    stub.h += LINE_H;                                   /* 助手行已创建 */
    streamCb({ type: 'done', id: lastId });
    await waitIdle(8000);
  }

  const gaps = [];
  for (let i = 1; i <= 12; i++) {
    await sendTurn(i);
    gaps.push(stub.h - stub.top - OUT_H);
  }

  console.log('\n每轮结束后的距底偏差(px): ' + gaps.join(', '));
  check(gaps.every((g) => g <= 0), '每轮结束后均贴底（最新回复在输入栏上方可见）');
  check(gaps[gaps.length - 1] <= 0, '第 12 轮仍贴底（偏差未累加）');

  const lines = log.querySelectorAll('.line');
  check(lines.length >= 12, '历史行仍在 #log 内累积（实得 ' + lines.length + ' 行）');

  /* The fix must not touch layout: the input row stays #log's last child. */
  check(log.lastElementChild === doc.getElementById('inputline'),
    '输入行仍是 #log 的最后一个子元素（布局未被改动）');

  dom.window.close();
  console.log('\n' + (failed === 0 ? '滚动回归测试全部通过 ✓' : '滚动回归测试失败 ' + failed + ' 项'));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FAIL: ' + (e && e.stack || e)); process.exit(1); });
