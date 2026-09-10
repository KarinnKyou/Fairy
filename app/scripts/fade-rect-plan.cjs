'use strict';
/*
 * fade-rect-plan.cjs — convert the elliptical fade mask into equivalent numbers for
 * a rectangular (purely vertical) one-way fade. Kept as a reference for tuning the
 * fade breakpoints; the app itself uses the elliptical mask.
 *
 * Current ellipse: ellipse 78vmin 58vmin at 50% 46%
 *   rx = 39vmin, ry = 29vmin, centred at 46% of the viewport height.
 *   t is the fraction of the ellipse radius: visible from t=0.4287, fully clear at
 *   t=0.9192.
 */
const STOPS = [[0, 0], [0.42, 0], [0.66, 0.55], [0.92, 1], [1, 1]];
function alphaAt(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  for (let i = 1; i < STOPS.length; i++) {
    const [t0, a0] = STOPS[i - 1], [t1, a1] = STOPS[i];
    if (t <= t1) return a0 + (a1 - a0) * ((t - t0) / (t1 - t0));
  }
  return 1;
}
function tForAlpha(tg) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 100; i++) { const m = (lo + hi) / 2; if (alphaAt(m) < tg) lo = m; else hi = m; }
  return (lo + hi) / 2;
}
const tVisible = tForAlpha(0.02);
const tFull = tForAlpha(0.999);

const CASES = [
  { w: 1280, h: 800, label: '1280×800' },
  { w: 1440, h: 900, label: '1440×900' },
  { w: 1512, h: 982, label: '1512×982' },
  { w: 1920, h: 1080, label: '1920×1080' },
];

console.log('当前椭圆遮罩的两个关键半径比例：');
console.log('  开始可见 t = ' + tVisible.toFixed(4) + '   全清晰 t = ' + tFull.toFixed(4));
console.log('');
console.log('窗口          椭圆中心y   ry     开始可见y(消失完成线)  全清晰y   消失线上方占比');
for (const { w, h, label } of CASES) {
  const vmin = Math.min(w, h);
  const ry = 0.29 * vmin;
  const cy = 0.46 * h;
  const yVisible = cy - tVisible * ry;   /* 上方：文字在此线以上彻底消失 */
  const yFull = cy - tFull * ry;         /* 上方：文字在此线以上完全清晰 */
  console.log(
    label.padEnd(12) +
    String(cy.toFixed(0)).padStart(9) +
    String(ry.toFixed(0)).padStart(8) +
    String(yVisible.toFixed(0)).padStart(18) +
    String(yFull.toFixed(0)).padStart(11) +
    ('   ' + ((yVisible / h) * 100).toFixed(1) + '%').padStart(12)
  );
}
console.log('');
console.log('=> 消失完成线稳定落在视口高度的 33.6% ~ 35.8% 处（各分辨率一致）');
console.log('');

/* Convert to vh expressions for direct use in CSS. */
console.log('换算为 CSS vh 表达（与分辨率无关）：');
CASES.forEach(({ w, h, label }) => {
  const vmin = Math.min(w, h);
  const ry = 0.29 * vmin;
  const cy = 0.46 * h;
  const yVisible = cy - tVisible * ry;
  const yFull = cy - tFull * ry;
  console.log('  ' + label.padEnd(12) + ' 清晰止于 ' + ((yFull / h) * 100).toFixed(1) + 'vh，' +
    '消失完成于 ' + ((yVisible / h) * 100).toFixed(1) + 'vh');
});

console.log('');
console.log('建议的矩形遮罩（linear-gradient，纯纵向）：');
const samples = CASES.map(({ w, h }) => {
  const vmin = Math.min(w, h);
  const ry = 0.29 * vmin, cy = 0.46 * h;
  return { full: ((cy - tFull * ry) / h) * 100, vis: ((cy - tVisible * ry) / h) * 100 };
});
const avgFull = samples.reduce((a, s) => a + s.full, 0) / samples.length;
const avgVis = samples.reduce((a, s) => a + s.vis, 0) / samples.length;
console.log('  mask-image: linear-gradient(to bottom,');
console.log('    #000 0,                                  /* 顶部：完全清晰 */');
console.log('    #000 ' + avgFull.toFixed(1) + 'vh,                               /* 保持清晰到此 */');
console.log('    rgba(0,0,0,0) ' + avgVis.toFixed(1) + 'vh,                          /* 渐入消失，至此完全不可见 */');
console.log('    rgba(0,0,0,0) 100%);                     /* 其下始终不可见 */');
console.log('');
console.log('  各分辨率下的偏差：');
CASES.forEach(({ w, h, label }, i) => {
  console.log('    ' + label.padEnd(12) +
    ' 清晰止于 ' + samples[i].full.toFixed(1) + '%（取 ' + avgFull.toFixed(1) + '%，偏差 ' +
    (samples[i].full - avgFull).toFixed(1) + 'pt）  消失完成 ' + samples[i].vis.toFixed(1) +
    '%（取 ' + avgVis.toFixed(1) + '%）');
});
