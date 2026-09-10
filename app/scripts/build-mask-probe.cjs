'use strict';
/*
 * build-mask-probe.cjs — generate a side-by-side mask comparison page under www/.
 * Each cell is a fixed-height band with one mask variant, so the direction
 * (which end is clear, which end disappears) is visible at a glance.
 * Self-contained: no iframes, no dependency on the live page.
 */
const fs = require('fs');
const path = require('path');

const WWW = path.resolve(__dirname, '..', 'www');

const VARIANTS = [
  { id: 'A', name: 'correct direction: clear at bottom, gone at top', mask: 'linear-gradient(to bottom, rgba(0,0,0,0) 0, rgba(0,0,0,0) 66.4%, #000 80.7%, #000 100%)' },
  { id: 'B', name: 'reversed direction (was a real bug)', mask: 'linear-gradient(to bottom, #000 0, #000 19.3%, rgba(0,0,0,0) 33.6%, rgba(0,0,0,0) 100%)' },
  { id: 'C', name: 'correct direction + transparent keyword', mask: 'linear-gradient(to bottom, transparent 0, transparent 66.4%, #000 80.7%, #000 100%)' },
  { id: 'D', name: 'correct direction + single transparent stop', mask: 'linear-gradient(to bottom, transparent 66.4%, #000 80.7%)' },
  { id: 'E', name: 'webkit prefix only', mask: 'linear-gradient(to bottom, transparent 0, transparent 66.4%, #000 80.7%, #000 100%)', webkitOnly: true },
  { id: 'F', name: 'no mask (control)', mask: 'none' },
];

const cells = VARIANTS.map((v) => {
  const decl = v.mask === 'none'
    ? '    -webkit-mask-image: none;\n    mask-image: none;'
    : (v.webkitOnly
      ? '    -webkit-mask-image: ' + v.mask + ';'
      : '    -webkit-mask-image: ' + v.mask + ';\n    mask-image: ' + v.mask + ';');
  return `
  <div class="cell">
    <div class="hd"><b>${v.id}</b> ${v.name}</div>
    <div class="stage">
      <div class="band" style="${decl.replace(/\n\s*/g, ' ')}">
        <div class="row">newest reply (bottom - must stay clear)</div>
        <div class="row mid">middle (should fade)</div>
        <div class="row top">oldest lines (top - must disappear)</div>
      </div>
    </div>
    <div class="code">${v.mask.replace(/</g, '&lt;')}${v.webkitOnly ? '   (webkit only)' : ''}</div>
  </div>`;
}).join('');

const page = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>HDD mask comparison</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#0a1018;color:#dbe9f5;font:13px/1.5 Consolas,monospace}
  h1{font-size:15px;margin:0;padding:11px 16px;background:#0f1a26;border-bottom:1px solid #22303f;color:#9fd8ff}
  .tip{padding:9px 16px;background:#101c28;border-bottom:1px solid #1b2836;color:#8fb0c6;font-size:12px}
  .tip b{color:#ffd479}
  .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;padding:12px}
  .cell{background:#0d1620;border:1px solid #1e2c3a;border-radius:6px;overflow:hidden}
  .hd{padding:6px 10px;font-size:12px;background:#122032;color:#9fd8ff}
  .hd b{color:#fff}
  .stage{padding:10px;background:#07101c}
  .band{height:200px;position:relative;background:#07101c;border:1px dashed #24405a}
  .band .row{position:absolute;left:10px;right:10px;color:#eaf4fb;font-size:15px}
  .band .top{top:8px}
  .band .mid{top:88px}
  .band .row:not(.top):not(.mid){bottom:8px;color:#f4fbff}
  .code{padding:5px 10px 8px;font-size:11px;color:#5e7a8d;word-break:break-all}
</style></head>
<body>
<h1>HDD mask comparison - each band is 200px tall; compare the three lines</h1>
<div class="tip">
  Expected: <b>the bottom line stays clear</b>, <b>the top line disappears</b>, the middle line sits in between.
</div>
<div class="grid">${cells}</div>
</body></html>`;

fs.writeFileSync(path.join(WWW, 'mask-probe.html'), page, 'utf8');

/* Remove iframe copies left behind by an earlier version of this probe. */
for (const f of fs.readdirSync(WWW)) {
  if (/^probe-[A-F]\.html$/.test(f)) fs.unlinkSync(path.join(WWW, f));
}
console.log('已生成 www/mask-probe.html（自包含，共 ' + VARIANTS.length + ' 格）');
console.log('已清理上一版的 iframe 副本页');
VARIANTS.forEach((v) => console.log('  ' + v.id + '  ' + v.name));
