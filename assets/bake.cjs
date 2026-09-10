'use strict';
/*
 * bake.cjs — Fairy Visual Assets 生成器
 * ---------------------------------------------------------------------------
 * 输入：source/ 下的资产源模块（自 Fairy-DSH-main/fairy-visual/dsh-fairy-visual
 *       src/client 逐字复制；CJS 与 ESM 分区保存，保证可原样执行）。
 * 输出（assets/）：
 *   svg/    fairy-eye.svg / fairy-eye-thinking.svg / fairy-eye-comforting.svg
 *           fairy-halo.svg / fairy-pulse.svg        （可独立打开的 SVG）
 *   css/    fairy-mascot.css / fairy-hdd-theme.css  （抽取自源码的原始 CSS）
 *   tokens/ fairy-palette.json                      （配色/变量/字体统计）
 *   preview.html                                    （资产画廊 + 交互演示）
 *   ../MANIFEST.json                                （来源映射 + SHA-256）
 *
 * 只读依赖：mascot-geometry / mascot-eye-svg / mascot-effects-svg / mascot-style
 * 为纯 CommonJS 自包含模块；style.js 为 ESM，经最小 document 桩执行以抽取 CSS。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'assets', 'source');
const OUT_SVG = path.join(ROOT, 'assets', 'svg');
const OUT_CSS = path.join(ROOT, 'assets', 'css');
const OUT_TOKENS = path.join(ROOT, 'assets', 'tokens');
const ORIGIN_BASE = 'Fairy-DSH-main/fairy-visual/dsh-fairy-visual/src/client';

for (const d of [OUT_SVG, OUT_CSS, OUT_TOKENS]) fs.mkdirSync(d, { recursive: true });

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const manifest = [];
const record = (rel, kind, origin) => {
  const abs = path.join(ROOT, rel);
  const buf = fs.readFileSync(abs);
  manifest.push({ file: rel, kind, origin: origin || null, bytes: buf.length, sha256: sha256(buf) });
  return buf;
};
const writeFile = (rel, content, kind, origin) => {
  fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true });
  fs.writeFileSync(path.join(ROOT, rel), content);
  record(rel, kind, origin);
};

/*
 * Source digest, recorded in the palette and the manifest as `source_digest`.
 *
 * This replaces a `generated_at` wall-clock stamp. That stamp lands in
 * assets/tokens/fairy-palette.json, assets/preview.html and MANIFEST.json, so every run
 * rewrote three tracked files with no content change: `npm test` (which bakes) left the
 * tree dirty, and MANIFEST.json's promise of "SHA-256 over the exact file bytes" could not
 * be reproduced from a clean checkout.
 *
 * A digest of the inputs is reproducible anywhere, needs no subprocess (a `git log` shell
 * call behaved differently inside a sandbox, silently changing the output), and answers the
 * more useful question: which sources produced this. Use git history for "when".
 */
function sourceDigest() {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(SOURCE);

  const h = crypto.createHash('sha256');
  for (const f of files) {
    /* Name as well as bytes, so renaming a source changes the digest. */
    h.update(path.relative(ROOT, f).split(path.sep).join('/'));
    h.update('\0');
    h.update(fs.readFileSync(f));
    h.update('\0');
  }
  return 'sha256:' + h.digest('hex');
}

const SOURCE_DIGEST = sourceDigest();

/* ============================== 载入 CJS 资产模块 ============================== */
const eyeSVG = require(path.join(SOURCE, 'mascot-eye-svg.js'));
const fx = require(path.join(SOURCE, 'mascot-effects-svg.js'));
const mascotCSS = require(path.join(SOURCE, 'mascot-style.js'));

/* ============================== 独立 SVG 默认样式 ============================== */
const BASE_EYE_CSS = `
svg{display:block;width:100%;height:auto;overflow:visible}
:root{--dsh-fairy-outer-halo-color:#c9f8ff}
.dsh-fairy-signal{transform-origin:80px 80px}
.dsh-fairy-image{opacity:1}
.dsh-fairy-glitch-blocks{opacity:0;display:none}
.dsh-fairy-eye{transform:scale(.90);transform-origin:80px 80px}
.dsh-fairy-eye-flicker{opacity:0;animation:none}
.dsh-fairy-corners{animation:dsh-fairy-lashes 15s linear infinite;transform-origin:80px 80px;will-change:transform}
.dsh-fairy-sclera{animation:dsh-fairy-pulse-outer .72s cubic-bezier(.72,0,.28,1) 0s infinite alternate;transform-box:view-box;transform-origin:80px 80px;will-change:transform}
.dsh-fairy-layer-three{animation:dsh-fairy-pulse-three .72s cubic-bezier(.72,0,.28,1) -.045s infinite alternate;transform-box:view-box;transform-origin:80px 80px;will-change:transform}
.dsh-fairy-layer-two{animation:dsh-fairy-pulse-two .72s cubic-bezier(.72,0,.28,1) -.09s infinite alternate;transform-box:view-box;transform-origin:80px 80px;will-change:transform}
.dsh-fairy-layer-one{animation:dsh-fairy-pulse-inner .72s cubic-bezier(.72,0,.28,1) -.18s infinite alternate;transform-box:view-box;transform-origin:80px 80px;will-change:transform}
@keyframes dsh-fairy-lashes{to{transform:rotate(360deg)}}
@keyframes dsh-fairy-pulse-outer{from{transform:scale(.985)}to{transform:scale(.91)}}
@keyframes dsh-fairy-pulse-three{from{transform:scale(1)}to{transform:scale(.90)}}
@keyframes dsh-fairy-pulse-two{from{transform:scale(1)}to{transform:scale(.87)}}
@keyframes dsh-fairy-pulse-inner{from{transform:scale(1)}to{transform:scale(.85)}}
@media (prefers-reduced-motion:reduce){svg *{animation:none!important}}
`;

const THINKING_EYE_CSS = `
.dsh-fairy-eye{clip-path:url(#dsh-fairy-thinking-eye-clip)}
.dsh-fairy-thinking-clip-shape{animation:dsh-fairy-thinking-clip .72s cubic-bezier(.72,0,.28,1) 0s infinite alternate;transform-box:view-box;transform-origin:80px 60px}
@keyframes dsh-fairy-thinking-clip{from{transform:translateY(14.5px) scaleY(.55)}to{transform:translateY(15.5px)}}
`;
const COMFORTING_EYE_CSS = `
.dsh-fairy-eye{clip-path:url(#dsh-fairy-comforting-eye-clip)}
.dsh-fairy-comforting-clip-shape{animation:dsh-fairy-comforting-clip .72s cubic-bezier(.72,0,.28,1) 0s infinite alternate;transform-box:view-box;transform-origin:80px 60px}
@keyframes dsh-fairy-comforting-clip{from{transform:translateY(-4px)}to{transform:translateY(4px)}}
`;

const PULSE_SVG_CSS = `
svg{display:block;width:min(80vw,720px);height:auto;overflow:visible}
.dsh-fairy-lash-pulse{fill:none}
.dsh-fairy-lash-pulse-wave{display:block;visibility:visible;opacity:1;transform-box:view-box;transform-origin:80px 80px;animation:dsh-fairy-lash-pulse 4s cubic-bezier(.42,0,.22,1) infinite;will-change:opacity,transform}
@keyframes dsh-fairy-lash-pulse{0%{opacity:0;transform:scale(.98)}5%{opacity:.72}12%{opacity:.52}20%{opacity:.19}27%{opacity:0}36%,100%{opacity:0;transform:scale(2.78)}}
@media (prefers-reduced-motion:reduce){svg *{animation:none!important}}
`;

const HALO_SVG_CSS = `
svg{display:block;width:min(92vw,900px);height:auto;overflow:visible}
.dsh-fairy-halo{color:#c9efff}
`;

const injectStyle = (markup, css) => {
  const idx = markup.indexOf('</svg>');
  if (idx < 0) throw new Error('cannot find </svg> in markup');
  return markup.slice(0, idx) + '<style>\n' + css + '\n</style>\n' + markup.slice(idx);
};

/* ============================== 烘焙 SVG 文件 ============================== */
const XML = '<?xml version="1.0" encoding="UTF-8"?>\n';
const variants = [
  ['fairy-eye.svg', BASE_EYE_CSS],
  ['fairy-eye-thinking.svg', BASE_EYE_CSS + THINKING_EYE_CSS],
  ['fairy-eye-comforting.svg', BASE_EYE_CSS + COMFORTING_EYE_CSS],
];
for (const [name, css] of variants) {
  writeFile(path.join('assets/svg', name), XML + injectStyle(eyeSVG, css) + '\n', 'baked', ORIGIN_BASE + '/mascot-eye-svg.js');
}
writeFile(path.join('assets/svg', 'fairy-pulse.svg'), XML + injectStyle(fx.PULSE_SVG, PULSE_SVG_CSS) + '\n', 'baked', ORIGIN_BASE + '/mascot-effects-svg.js');
writeFile(path.join('assets/svg', 'fairy-halo.svg'), XML + injectStyle(fx.HALO_SVG, HALO_SVG_CSS) + '\n', 'baked', ORIGIN_BASE + '/mascot-effects-svg.js');

/* ============================== CSS 抽取 ============================== */
writeFile(path.join('assets/css', 'fairy-mascot.css'), mascotCSS, 'extracted', ORIGIN_BASE + '/mascot-style.js');

let themeCSS = '';
(async () => {
  /* 最小 document 桩：让 ESM 版 style.js 的 injectStyles() 在 Node 中把全部
     section 文本收集进一个 style 元素，从而原样导出整套 HDD 主题 CSS。 */
  globalThis.document = {
    getElementById: () => null,
    createElement: () => {
      let text = '';
      const el = {
        setAttribute() {},
        get textContent() { return text; },
        set textContent(v) { text = v; },
      };
      return el;
    },
    head: { appendChild: (el) => { themeCSS = el.textContent; } },
    documentElement: {},
  };
  const styleMod = await import(pathToFileURL(path.join(SOURCE, 'esm', 'style.js')).href);
  styleMod.injectStyles();
  if (!themeCSS) throw new Error('style.js extraction produced no CSS');
  const header =
    '/* fairy-hdd-theme.css\n' +
    ' * 抽取自 Fairy-DSH-main/fairy-visual/dsh-fairy-visual/src/client/style.js\n' +
    ' *（经最小 document 桩执行 injectStyles()，文本逐字保留，仅前置本注释）。\n' +
    ' * 注意：规则按 html[data-dsh-fairy-visual] 门控，并与 DSH Web 应用 DOM\n' +
    ' *（composer dock / sidebar / 会话区等）绑定；脱离插件应用时仅部分可用。\n' +
    ' */\n';
  writeFile(path.join('assets/css', 'fairy-hdd-theme.css'), header + themeCSS, 'extracted', ORIGIN_BASE + '/style.js');

  /* ============================== 配色 token ============================== */
  const sources = {
    'fairy-hdd-theme.css': themeCSS,
    'fairy-mascot.css': mascotCSS,
    'mascot-eye-svg.js': eyeSVG,
    'mascot-effects-svg.js': fx.PULSE_SVG + '\n' + fx.HALO_SVG,
  };
  const hexMap = new Map();
  const funcMap = new Map();
  const varMap = new Map();
  const fontMap = new Map();
  const perSource = {};
  for (const [name, text] of Object.entries(sources)) {
    const hexes = text.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    const funcs = text.match(/rgba?\([^)]*\)/g) || [];
    const vars = text.match(/var\((--[\w-]+)/g) || [];
    const fonts = text.match(/font-family:[^;}"]*"[^"]+"/g) || [];
    for (const h of hexes) hexMap.set(h.toLowerCase(), (hexMap.get(h.toLowerCase()) || 0) + 1);
    for (const f of funcs) funcMap.set(f, (funcMap.get(f) || 0) + 1);
    for (const v of vars) varMap.set(v.slice(4, -1), (varMap.get(v.slice(4, -1)) || 0) + 1);
    for (const f of fonts) {
      const names = f.slice('font-family:'.length).split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
      for (const n of names) if (n !== 'sans-serif' && n !== 'serif') fontMap.set(n, (fontMap.get(n) || 0) + 1);
    }
    perSource[name] = {
      hex: hexes.length,
      colorFunctions: funcs.length,
      cssVariables: vars.length,
    };
  }
  const sortDesc = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const palette = {
    schema_version: '1.1',   /* 1.1: generated_at (wall clock) -> source_digest */
    source_digest: SOURCE_DIGEST,
    origin: 'Fairy-DSH-main (Apache-2.0) — 见 ../NOTICE 与 ../THIRD_PARTY_NOTICES.md',
    counts_per_source: perSource,
    hex: sortDesc(hexMap).map(([value, count]) => ({ value, count })),
    color_functions: sortDesc(funcMap).slice(0, 120).map(([value, count]) => ({ value, count })),
    css_variables: sortDesc(varMap).map(([name, count]) => ({ name, count })),
    font_families: sortDesc(fontMap).map(([name, count]) => ({ name, count })),
  };
  writeFile(path.join('assets/tokens', 'fairy-palette.json'), JSON.stringify(palette, null, 2) + '\n', 'generated', 'derived from source/ + style.js extraction');

  /* ============================== preview.html ============================== */
  buildPreview({ palette });

  /* ============================== MANIFEST ============================== */
  const extra = [
    ['package.json', 'authored', null],
    ['README.md', 'authored', null],
    ['LICENSE', 'verbatim-copy', 'Fairy-DSH-main/LICENSE'],
    ['NOTICE', 'verbatim-copy', 'Fairy-DSH-main/NOTICE'],
    ['THIRD_PARTY_NOTICES.md', 'verbatim-copy', 'Fairy-DSH-main/THIRD_PARTY_NOTICES.md'],
    ['assets/source/mascot-geometry.js', 'verbatim-copy', ORIGIN_BASE + '/mascot-geometry.js'],
    ['assets/source/mascot-eye-svg.js', 'verbatim-copy', ORIGIN_BASE + '/mascot-eye-svg.js'],
    ['assets/source/mascot-effects-svg.js', 'verbatim-copy', ORIGIN_BASE + '/mascot-effects-svg.js'],
    ['assets/source/mascot-style.js', 'verbatim-copy', ORIGIN_BASE + '/mascot-style.js'],
    ['assets/source/esm/package.json', 'authored', null],
    ['assets/source/esm/constants.js', 'verbatim-copy', ORIGIN_BASE + '/constants.js'],
    ['assets/source/esm/style.js', 'verbatim-copy', ORIGIN_BASE + '/style.js'],
    ['assets/bake.cjs', 'authored', null],
  ];
  for (const [rel, kind, origin] of extra) {
    if (fs.existsSync(path.join(ROOT, rel))) record(rel, kind, origin);
  }
  const manifestDoc = {
    schema_version: '1.1',   /* 1.1: generated_at (wall clock) -> source_digest */
    source_digest: SOURCE_DIGEST,
    note: 'SHA-256 over the exact file bytes as stored in this project. verbatim-copy files are byte-identical to the originals in Fairy-DSH-main. Baking is reproducible: unchanged sources produce identical bytes, so these hashes can be re-derived from a clean checkout.',
    files: manifest.slice().sort((a, b) => a.file.localeCompare(b.file)),
  };
  /* MANIFEST.json 不列入自身（自引用哈希无意义）；files 为快照数组。 */
  fs.writeFileSync(path.join(ROOT, 'MANIFEST.json'), JSON.stringify(manifestDoc, null, 2) + '\n');

  console.log('bake OK — produced:');
  for (const m of [...manifest].sort((a, b) => a.file.localeCompare(b.file))) {
    console.log('  ' + m.file.padEnd(38) + (m.kind + '').padEnd(12) + m.bytes + ' B');
  }
})();

/* ============================== preview.html 组装 ============================== */
function buildPreview({ palette }) {
  const eyeMarkup = eyeSVG;
  const pulseMarkup = fx.PULSE_SVG;
  const haloMarkup = fx.HALO_SVG;
  const hexTop = palette.hex.slice(0, 64);
  const varChips = palette.css_variables.slice(0, 96);
  const swatches = hexTop.map(({ value }) =>
    '<button type="button" class="sw" style="background:' + value + '" data-hex="' + value + '" title="' + value + '">' + value + '</button>'
  ).join('\n      ');
  const varChipsHtml = varChips.map(({ name, count }) =>
    '<code class="chip" title="出现 ' + count + ' 次">' + name + '</code>'
  ).join(' ');
  const paletteJson = JSON.stringify(palette);

  const html = `<!DOCTYPE html>
<html lang="zh-CN" data-dsh-fairy-visual data-dsh-fairy-mode="hdd" data-dsh-fairy-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fairy Visual Assets — H.D.D 资产画廊</title>
<link rel="stylesheet" href="css/fairy-mascot.css">
<link rel="stylesheet" href="css/fairy-hdd-theme.css">
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; }
  html[data-dsh-fairy-visual] body { background: #07101c; }
  html[data-dsh-fairy-visual][data-dsh-fairy-theme="light"] body { background: #f7fafc; }
  body { color: #cfe2f0; font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }
  html[data-dsh-fairy-visual][data-dsh-fairy-theme="light"] body { color: #23384a; }
  header.page { max-width: 1080px; margin: 0 auto; padding: 34px 24px 6px; }
  header.page h1 { margin: 0 0 6px; font-size: 26px; letter-spacing: .02em; }
  header.page .sub { opacity: .75; font-size: 13px; line-height: 1.7; }
  section { max-width: 1080px; margin: 0 auto; padding: 26px 24px; }
  section > h2 { font-size: 15px; margin: 0 0 14px; letter-spacing: .1em; text-transform: uppercase; opacity: .8; }
  .controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 18px 0 4px; }
  .controls .group { display: inline-flex; align-items: center; gap: 2px; padding: 3px; border: 1px solid rgba(126,220,255,.25); border-radius: 999px; background: rgba(10,24,48,.55); }
  html[data-dsh-fairy-visual][data-dsh-fairy-theme="light"] .controls .group { background: rgba(255,255,255,.75); border-color: rgba(32,111,149,.25); }
  .controls .group > b { font-size: 11px; font-weight: 600; padding: 0 10px; opacity: .75; letter-spacing: .06em; }
  .controls button { border: 0; background: transparent; color: inherit; font: inherit; font-size: 12px; padding: 5px 12px; border-radius: 999px; cursor: pointer; opacity: .72; }
  .controls button:hover { background: rgba(126,220,255,.14); opacity: 1; }
  .controls button.on { background: #1688ce; color: #f4fbff; opacity: 1; }
  #demo-stage { position: relative; display: flex; align-items: center; justify-content: center; min-height: 66vh; border: 1px solid rgba(126,220,255,.16); border-radius: 18px; overflow: hidden; }
  #demo-stage .dsh-hdd-background-host { border-radius: inherit; }
  #mascot-demo { --dsh-fairy-steady-rate: 1; position: relative; }
  #demo-stage [data-dsh-fairy-mascot-root="true"] { width: min(72%, 46vh, 460px); height: min(72%, 46vh); }
  .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }
  .card { border: 1px solid rgba(126,220,255,.18); border-radius: 14px; padding: 14px; background: rgba(14,36,61,.35); display: flex; flex-direction: column; gap: 10px; }
  html[data-dsh-fairy-visual][data-dsh-fairy-theme="light"] .card { background: rgba(255,255,255,.7); border-color: rgba(32,111,149,.22); }
  .card .frame { border-radius: 10px; background: repeating-linear-gradient(0deg, rgba(255,255,255,.02) 0 1px, transparent 1px 22px); display: grid; place-items: center; min-height: 190px; }
  .card img, .card svg { width: 100%; height: auto; }
  .card .name { font-size: 13px; font-weight: 600; }
  .card .path { font-size: 11px; opacity: .6; word-break: break-all; }
  .swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 8px; }
  .sw { font: inherit; font-size: 10px; color: #fff; text-align: left; padding: 8px 9px; border: 1px solid rgba(255,255,255,.14); border-radius: 8px; cursor: copy; text-shadow: 0 1px 2px rgba(0,0,0,.55); }
  html[data-dsh-fairy-visual][data-dsh-fairy-theme="light"] .sw { text-shadow: 0 1px 2px rgba(0,0,0,.35); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; line-height: 1; }
  .chip { font-size: 11px; padding: 5px 8px; border-radius: 999px; background: rgba(126,220,255,.10); border: 1px solid rgba(126,220,255,.22); color: #9fd8ef; }
  html[data-dsh-fairy-visual][data-dsh-fairy-theme="light"] .chip { color: #1d5f86; background: rgba(22,136,206,.08); border-color: rgba(22,136,206,.25); }
  .hint { font-size: 12px; opacity: .7; line-height: 1.8; }
  code.inline { background: rgba(126,220,255,.12); border-radius: 5px; padding: 1px 6px; font-size: 12px; }
  footer { max-width: 1080px; margin: 0 auto; padding: 10px 24px 40px; font-size: 12px; opacity: .6; line-height: 1.8; }
  .btn-copy { font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 999px; border: 1px solid rgba(126,220,255,.35); background: transparent; color: inherit; cursor: pointer; }
  .btn-copy:hover { background: rgba(126,220,255,.16); }
</style>
</head>
<body>

<header class="page">
  <h1>Fairy Visual Assets · H.D.D 视觉资产画廊</h1>
  <p class="sub">从 <code class="inline">Fairy-DSH-main</code> 的 <code class="inline">dsh-fairy-visual</code> 插件中提取的纯视觉资产（无插件运行时）。
  吉祥物为内联 SVG 实时渲染；下方 <b>静态文件</b> 为烘焙后可独立使用的 SVG。</p>
  <div class="controls" id="top-controls">
    <span class="group" id="g-theme"><b>主题</b><button data-act="theme" data-v="dark">深色</button><button data-act="theme" data-v="light">浅色</button></span>
    <span class="group" id="g-state"><b>状态</b><button data-act="state" data-v="">正常</button><button data-act="state" data-v="thinking">思考</button><button data-act="state" data-v="comforting">安慰</button></span>
    <span class="group" id="g-glitch"><b>故障</b><button data-act="glitch" data-v="none">无</button><button data-act="glitch" data-v="threads">线程</button><button data-act="glitch" data-v="blocks">切片</button><button data-act="glitch" data-v="rand">随机</button></span>
    <span class="group" id="g-power"><b>模式</b><button data-act="power" data-v="normal">标准</button><button data-act="power" data-v="low">低功耗</button></span>
    <span class="group" id="g-speed"><b>节奏</b><button data-act="speed" data-v="0.7">0.7×</button><button data-act="speed" data-v="1">1×</button><button data-act="speed" data-v="1.5">1.5×</button></span>
  </div>
</header>

<section>
  <h2>实时演示（交互版）</h2>
  <div id="demo-stage">
    <div class="dsh-hdd-background-host" aria-hidden="true"><div class="dsh-hdd-fx"><div class="dsh-hdd-glow dsh-hdd-glow-a"></div><div class="dsh-hdd-glow dsh-hdd-glow-b"></div><div class="dsh-hdd-glow dsh-hdd-glow-c"></div></div></div>
    <div id="mascot-demo" data-dsh-fairy-mascot-root="true" aria-label="Fairy H.D.D 吉祥物演示">
      ${haloMarkup}
      ${pulseMarkup}
      ${eyeMarkup}
    </div>
  </div>
  <p class="hint">拖动开关观察：主题深/浅色、思考/安慰眼睑（<code class="inline">data-state</code>）、线程/切片故障（复用 <code class="inline">--dsh-g-*</code> 位移变量）、低功耗（隐藏光晕/辉光层）与动画节奏。静态文件图例见下节。</p>
</section>

<section>
  <h2>烘焙 SVG（独立静态文件）</h2>
  <div class="gallery">
    <div class="card"><div class="frame"><img src="svg/fairy-eye.svg" alt="fairy-eye"></div><div class="name">Fairy 大眼睛 · 常态</div><div class="path">svg/fairy-eye.svg</div></div>
    <div class="card"><div class="frame"><img src="svg/fairy-eye-thinking.svg" alt="fairy-eye-thinking"></div><div class="name">思考态眼睑</div><div class="path">svg/fairy-eye-thinking.svg</div></div>
    <div class="card"><div class="frame"><img src="svg/fairy-eye-comforting.svg" alt="fairy-eye-comforting"></div><div class="name">安慰态眼睑</div><div class="path">svg/fairy-eye-comforting.svg</div></div>
    <div class="card"><div class="frame"><img src="svg/fairy-halo.svg" alt="fairy-halo"></div><div class="name">光环层 Halo</div><div class="path">svg/fairy-halo.svg</div></div>
    <div class="card"><div class="frame"><img src="svg/fairy-pulse.svg" alt="fairy-pulse"></div><div class="name">睫毛脉冲 Pulse</div><div class="path">svg/fairy-pulse.svg</div></div>
  </div>
</section>

<section>
  <h2>配色 Token（自动提取）</h2>
  <div class="swatches">
    ${swatches}
  </div>
  <p class="hint">点击色块复制 <code class="inline">#hex</code>。完整统计（含 rgba()/渐变函数与计数）见 <code class="inline">tokens/fairy-palette.json</code>。</p>
</section>

<section>
  <h2>CSS 变量与字体</h2>
  <div class="chips">${varChipsHtml}</div>
  <p class="hint">变量取自 <code class="inline">var(--…)</code> 引用计数（含 <code class="inline">--dsw-*</code> 官方 token 与 <code class="inline">--dsh-fairy-*</code> 插件 token）。品牌字族优先序列：
  <code class="inline">"Avenir Next","Arial Narrow","DIN Condensed","Microsoft YaHei",sans-serif</code>。</p>
</section>

<footer>
  Fairy Visual Assets — 从 Fairy-DSH-main 提取（Apache-2.0，© 2026 Chengzhibense，见 <code class="inline">NOTICE</code>）。
  游戏文本/官方素材/商标不在本资产包内。来源映射与 SHA-256 见 <code class="inline">MANIFEST.json</code>，说明见 <code class="inline">README.md</code>。
</footer>

<script>
var PALETTE = ${paletteJson};
function demo(){ return document.getElementById('mascot-demo'); }
function mark(groupId, activeBtn){ var g=document.getElementById(groupId); if(!g) return; var bs=g.querySelectorAll('button'); for(var i=0;i<bs.length;i++){ bs[i].classList.toggle('on', bs[i]===activeBtn); } }
function syncOn(sel, val){ document.querySelectorAll(sel).forEach(function(b){ b.classList.toggle('on', b.dataset.v===String(val)); }); }
function applyTheme(v){
  document.documentElement.dataset.dshFairyTheme = v;
  syncOn('#g-theme button', v);
}
function applyState(v){
  var d=demo(); if(v===''){ d.removeAttribute('data-state'); } else { d.setAttribute('data-state', v); }
  syncOn('#g-state button', v);
}
function setSliceRandoms(){
  var d=demo();
  var s=['s1','s2','s3','s4','s5'];
  for(var i=0;i<s.length;i++){ d.style.setProperty('--dsh-g-'+s[i]+'-x', (Math.round((Math.random()*2-1)*14))+'px'); }
  d.style.setProperty('--dsh-g-x', (Math.round((Math.random()*2-1)*5))+'px');
  d.style.setProperty('--dsh-g-skew', (Math.round((Math.random()*2-1)*1.2*10)/10)+'deg');
}
function applyGlitch(v){
  var d=demo();
  var sig=d.querySelector('.dsh-fairy-signal');
  if(v==='none'){ d.removeAttribute('data-transition-glitch'); if(sig) sig.removeAttribute('data-glitch'); syncOn('#g-glitch button', document.querySelector('#g-glitch button[data-v="none"]')); }
  else if(v==='rand'){
    d.setAttribute('data-transition-glitch','true'); setSliceRandoms();
    var which=(Math.random()<.5)?'threads':'blocks'; if(sig) sig.setAttribute('data-glitch', which);
    syncOn('#g-glitch button', document.querySelector('#g-glitch button[data-v="rand"]'));
    var self=this; setTimeout(function(){ applyGlitch('none'); }, 420);
  }
  else if(v==='threads'){ setSliceRandoms(); d.setAttribute('data-transition-glitch','true'); if(sig) sig.setAttribute('data-glitch','threads'); syncOn('#g-glitch button', document.querySelector('#g-glitch button[data-v="threads"]')); }
  else if(v==='blocks'){ setSliceRandoms(); d.setAttribute('data-transition-glitch','true'); if(sig) sig.setAttribute('data-glitch','blocks'); syncOn('#g-glitch button', document.querySelector('#g-glitch button[data-v="blocks"]')); }
}
function applyPower(v){
  var d=demo();
  if(v==='low'){ d.setAttribute('data-low-power',''); } else { d.removeAttribute('data-low-power'); }
  syncOn('#g-power button', v==='low' ? document.querySelector('#g-power button[data-v="low"]') : document.querySelector('#g-power button[data-v="normal"]'));
}
function applySpeed(v){
  var d=demo();
  d.dataset.dshFairyAnimationRate = v;
  d.style.setProperty('--dsh-fairy-steady-rate', v);
  syncOn('#g-speed button', v);
}
document.getElementById('top-controls').addEventListener('click', function(ev){
  var b=ev.target.closest('button'); if(!b||!b.dataset.act) return;
  var act=b.dataset.act, v=b.dataset.v;
  if(act==='theme') applyTheme(v);
  else if(act==='state') applyState(v);
  else if(act==='glitch') applyGlitch(v);
  else if(act==='power') applyPower(v);
  else if(act==='speed') applySpeed(v);
});
/* hex copy on click */
document.querySelectorAll('.sw').forEach(function(sw){
  sw.addEventListener('click', function(){ if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(sw.dataset.hex); } });
});
</script>
</body>
</html>
`;
  writeFile(path.join('assets', 'preview.html'), html, 'generated', 'bake.cjs (embeds baked markup + palette)');
}
