'use strict';
/*
 * icon.cjs — generate build-res/icon.png (Fairy eye) with no dependencies.
 * Includes a minimal PNG encoder (RGBA8 + zlib deflate).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; /* 8-bit RGBA */
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; /* filter: none */
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* Rasterize the eye shape; geometry is modelled on a 160x160 canvas. */
const S = 256, C = S / 2, SC = S / 160;
const px = Buffer.alloc(S * S * 4);

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}
function setPx(x, y, rgb, a) {
  const i = (y * S + x) * 4;
  /* Source-over blend: later draws win. */
  const sa = a / 255, da = px[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  px[i] = Math.round((rgb[0] * sa + px[i] * da * (1 - sa)) / oa);
  px[i + 1] = Math.round((rgb[1] * sa + px[i + 1] * da * (1 - sa)) / oa);
  px[i + 2] = Math.round((rgb[2] * sa + px[i + 2] * da * (1 - sa)) / oa);
  px[i + 3] = Math.round(oa * 255);
}
const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const u = x / SC, v = y / SC;
    const d = Math.hypot(u - 80, v - 80);
    if (d > 79) continue; /* outside the disc */

    /* Outer disc: vertical blue gradient with a thin bright rim. */
    let rgb;
    if (d > 67.6) {
      const t = clamp01((d - 67.6) / 1.2);
      rgb = mix([0xf2, 0xfb, 0xff], [0x5a, 0x6d, 0xf4], t * 0.75);
    } else {
      const g = clamp01((v - 12) / 136);
      rgb = g < 0.54
        ? mix([0x40, 0x53, 0xf0], [0x30, 0x45, 0xdc], g / 0.54)
        : mix([0x30, 0x45, 0xdc], [0x3d, 0x50, 0xc8], (g - 0.54) / 0.46);
    }
    setPx(x, y, rgb, 255);

    /* Corner lashes: rotated dark-blue squares in the four quadrants. */
    const a45 = Math.abs(Math.cos(Math.atan2(v - 80, u - 80)) - Math.sin(Math.atan2(v - 80, u - 80))) * 0.7071;
    const rot = Math.abs(u - 80) + Math.abs(v - 80);
    if (d > 44 && d < 68 && rot > 55 && a45 < 0.62) setPx(x, y, [0x2b, 0x33, 0x88], 235);

    /* Sclera, then iris rings. */
    if (d <= 48) setPx(x, y, [0xee, 0xf0, 0xf5], 255);
    if (d <= 33) setPx(x, y, [0x9d, 0xae, 0xe0], 255);
    if (d <= 24) setPx(x, y, [0xee, 0xf0, 0xf5], 255);
    if (d <= 23.4) setPx(x, y, [0x31, 0x7b, 0xcf], 255);
    if (d <= 16.4) setPx(x, y, [0x3b, 0x3d, 0x8a], 255);

    /* Highlight at (98, 100.5), radius 11. */
    const hd = Math.hypot(u - 98, v - 100.5);
    if (hd <= 15) setPx(x, y, [0xf5, 0xf8, 0xfd], Math.round(255 * clamp01(1 - (hd - 11) / 4)));
  }
}

const out = path.join(__dirname, '..', 'build-res', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, encodePng(S, S, px));
console.log('icon OK ->', out, fs.statSync(out).size, 'bytes');
