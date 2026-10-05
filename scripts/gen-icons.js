/**
 * Genera icon-192.png e icon-512.png sin dependencias externas.
 * Uso: node scripts/gen-icons.js
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', 'public', 'icons');

/* ---------- CRC32 (tabla) ---------- */
const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- dibujo ---------- */
const BG = [11, 15, 20];
const GREEN = [31, 215, 96];
const GREEN2 = [142, 240, 176];

function lerp(a, b, t) { return Math.round(a + (b - a) * t); }

function draw(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const S = size / 512;
  const radius = 112 * S;
  const cx = 256 * S;
  const cy = 256 * S;
  const R = 196 * S;

  // rotación de la cabeza de la nota
  const ang = -0.35;
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let r = 0, g = 0, b = 0, a = 255;

      // esquinas redondeadas -> transparencia fuera
      const rx = Math.max(0, Math.abs(x - size / 2) - (size / 2 - radius));
      const ry = Math.max(0, Math.abs(y - size / 2) - (size / 2 - radius));
      if (Math.hypot(rx, ry) > radius) {
        rgba[i + 3] = 0;
        continue;
      }

      r = BG[0]; g = BG[1]; b = BG[2];

      // círculo degradado
      const d = Math.hypot(x - cx, y - cy);
      if (d <= R) {
        const t = (x + y) / (2 * size);
        r = lerp(GREEN[0], GREEN2[0], t);
        g = lerp(GREEN[1], GREEN2[1], t);
        b = lerp(GREEN[2], GREEN2[2], t);
      }

      // silueta de la nota (se pinta encima solo dentro del círculo)
      let note = false;
      if (d <= R + 2 * S) {
        // cabeza elíptica rotada
        const dx = (x - 215 * S);
        const dy = (y - 335 * S);
        const u = dx * ca + dy * sa;
        const v = -dx * sa + dy * ca;
        if ((u * u) / (68 * S) ** 2 + (v * v) / (48 * S) ** 2 <= 1) note = true;

        // mástil
        if (x >= 272 * S && x <= 296 * S && y >= 155 * S && y <= 345 * S) note = true;

        // bandera curva
        const x0 = 296 * S;
        const span = 84 * S;
        if (x >= x0 && x <= x0 + span) {
          const t = (x - x0) / span;
          const yTop = (155 + 130 * t * t) * S;
          const thick = (40 * (1 - t * 0.5)) * S;
          if (y >= yTop && y <= yTop + thick) note = true;
        }
      }

      if (note) { r = BG[0]; g = BG[1]; b = BG[2]; }

      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = a;
    }
  }
  return encodePNG(size, size, rgba);
}

fs.mkdirSync(OUT, { recursive: true });
for (const s of [192, 512]) {
  const file = path.join(OUT, `icon-${s}.png`);
  fs.writeFileSync(file, draw(s));
  console.log('✓', file, fs.statSync(file).size, 'bytes');
}
