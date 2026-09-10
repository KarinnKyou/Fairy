'use strict';
/*
 * prep.cjs — build the app's www/ runtime directory.
 * Injects asset SVGs into the page template, copies css/svg, and registers fonts.
 * Idempotent: re-running rebuilds www/ from scratch.
 */
const fs = require('fs');
const path = require('path');

const APP = path.resolve(__dirname, '..');
const ROOT = path.resolve(APP, '..');
const ASSETS = path.join(ROOT, 'assets');
const SOURCE = path.join(ASSETS, 'source');
const FONT_SRC = path.join(APP, 'fonts');

const eyeSVG = require(path.join(SOURCE, 'mascot-eye-svg.js'));
const fx = require(path.join(SOURCE, 'mascot-effects-svg.js'));

/* NOTE: app/personality.js is no longer injected into the page. The persona is assembled
   by the main process (app/conversation.js) together with the profile and the current
   time, so the renderer never builds a prompt (docs/ADR.md ADR-001). */

const WWW = path.join(APP, 'www');
const WWW_ASSETS = path.join(WWW, 'assets');
const WWW_FONTS = path.join(WWW_ASSETS, 'fonts');
fs.mkdirSync(path.join(WWW_ASSETS, 'css'), { recursive: true });
fs.mkdirSync(path.join(WWW_ASSETS, 'svg'), { recursive: true });
fs.mkdirSync(WWW_FONTS, { recursive: true });

const template = fs.readFileSync(path.join(APP, 'src', 'live.template.html'), 'utf8');
const html = template
  .split('@@FAIRY_EYE@@').join(eyeSVG)
  .split('@@FAIRY_HALO@@').join(fx.HALO_SVG)
  .split('@@FAIRY_PULSE@@').join(fx.PULSE_SVG);
fs.writeFileSync(path.join(WWW, 'live.html'), html);

for (const f of fs.readdirSync(path.join(ASSETS, 'css'))) {
  fs.copyFileSync(path.join(ASSETS, 'css', f), path.join(WWW_ASSETS, 'css', f));
}
for (const f of fs.readdirSync(path.join(ASSETS, 'svg'))) {
  fs.copyFileSync(path.join(ASSETS, 'svg', f), path.join(WWW_ASSETS, 'svg', f));
}

const FONT_EXT = ['.ttf', '.otf', '.woff', '.woff2'];
const FORMAT = { '.ttf': 'truetype', '.otf': 'opentype', '.woff': 'woff', '.woff2': 'woff2' };

/* Minimal sfnt parser: read the family name and weight straight out of the font,
   so adding a font file to app/fonts/ needs no manual CSS. */
function sfntTable(buf, tag) {
  const num = buf.readUInt16BE(4);
  for (let i = 0; i < num; i++) {
    const rec = 12 + i * 16;
    if (buf.toString('ascii', rec, rec + 4) === tag) return { offset: buf.readUInt32BE(rec + 8), length: buf.readUInt32BE(rec + 12) };
  }
  return null;
}
function fontFamily(buf) {
  const name = sfntTable(buf, 'name');
  if (!name) return null;
  const count = buf.readUInt16BE(name.offset + 2);
  const strOff = buf.readUInt16BE(name.offset + 4);
  const decoders = [];
  for (let i = 0; i < count; i++) {
    const rec = name.offset + 6 + i * 12;
    const pid = buf.readUInt16BE(rec), eid = buf.readUInt16BE(rec + 2);
    const lang = buf.readUInt16BE(rec + 4);
    const nid = buf.readUInt16BE(rec + 6);
    const len = buf.readUInt16BE(rec + 8), off = buf.readUInt16BE(rec + 10);
    const raw = buf.slice(name.offset + strOff + off, name.offset + strOff + off + len);
    let text = null;
    if (pid === 3 && eid === 1) text = raw.toString('utf16le').replace(/\u0000/g, '');
    else if (pid === 1 && eid === 0) text = raw.toString('latin1');
    else if (pid === 0 && (eid === 0 || eid === 1)) text = raw.toString('utf16le').replace(/\u0000/g, '');
    else if (pid === 0 && (eid === 2 || eid === 3)) text = raw.toString('utf16be').replace(/\u0000/g, '');
    if (text) decoders.push({ nid, pid, eid, lang, text });
  }
  /* Prefer records without mojibake: some fonts ship a broken Windows (pid=3)
     name table; counting ASCII/CJK keeps the readable record on top. */
  const score = (d) => {
    let ascii = 0, cjk = 0;
    for (const ch of d.text) {
      const code = ch.codePointAt(0);
      if (code >= 0x20 && code <= 0x7e) ascii++;
      else if ((code >= 0x3000 && code <= 0x303f) ||
               (code >= 0x3400 && code <= 0x4dbf) ||
               (code >= 0x4e00 && code <= 0x9fff) ||
               (code >= 0xf900 && code <= 0xfaff)) cjk++;
    }
    let s = ascii * 2 + cjk;
    if (d.pid === 3 && d.eid === 1 && d.lang === 0x0409) s += 2;
    return s;
  };
  const pick = (nid) => {
    const list = decoders.filter((d) => d.nid === nid && d.text.trim().length > 0);
    if (!list.length) return null;
    list.sort((a, b) => score(b) - score(a));
    return list[0].text.trim();
  };
  return pick(16) || pick(1) || null;
}
function fontWeight(buf) {
  const os2 = sfntTable(buf, 'OS/2');
  if (!os2) return 400;
  const w = buf.readUInt16BE(os2.offset + 4);
  return w >= 1 && w <= 1000 ? w : 400;
}

/* Drop the previous run's fonts so removed files do not linger in www/. */
for (const f of fs.readdirSync(WWW_FONTS)) fs.unlinkSync(path.join(WWW_FONTS, f));

const fontFiles = fs.readdirSync(FONT_SRC)
  .filter((f) => FONT_EXT.includes(path.extname(f).toLowerCase()))
  .sort();
const faces = [];
fontFiles.forEach((f, i) => {
  const ext = path.extname(f).toLowerCase();
  const buf = fs.readFileSync(path.join(FONT_SRC, f));
  /* ASCII output name: the source filename may contain CJK characters. */
  const asciiName = 'app-font-' + (i + 1) + ext;
  fs.writeFileSync(path.join(WWW_FONTS, asciiName), buf);
  faces.push({
    file: asciiName,
    src: f,
    family: fontFamily(buf) || path.basename(f, ext),
    weight: fontWeight(buf),
    format: FORMAT[ext],
  });
});

let fontsCss = '/* generated by scripts/prep.cjs */\n';
if (faces.length === 0) {
  fontsCss += '/* no font files found in app/fonts */\n';
} else {
  for (const fc of faces) {
    fontsCss +=
      '@font-face{font-family:"' + fc.family.replace(/"/g, '\\"') +
      '";font-style:normal;font-weight:' + fc.weight +
      ';font-display:swap;src:url("' + fc.file + '") format("' + fc.format + '");}\n';
  }
}
fs.writeFileSync(path.join(WWW_FONTS, 'fonts.css'), fontsCss);

console.log('prep OK -> www/live.html + www/assets/{css,svg,fonts}');
for (const fc of faces) {
  console.log('  font: ' + fc.src + ' -> ' + fc.file + ' (family="' + fc.family + '", weight=' + fc.weight + ')');
}
