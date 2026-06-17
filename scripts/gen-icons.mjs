// Generate the PWA PNG icons (Android WebAPK install requires 192/512 PNG;
// the SVG-only manifest renders a placeholder icon on Android).
// Usage: node scripts/gen-icons.mjs  → writes icon-192.png / icon-512.png.
// Zero deps: draws the mark (teal rounded square + white "C" ring) into an
// RGBA buffer with 2x supersampling and hand-encodes the PNG via node:zlib.

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const BG = [0x16, 0x80, 0x6f, 255]; // --accent
const FG = [255, 255, 255, 255];

// Sample one (sub)pixel: rounded-square background, "C" ring on top.
function sample(x, y, size) {
  const r = size * 0.21; // corner radius
  const min = 0;
  const max = size;
  // Rounded-rect coverage (full canvas, so the maskable safe zone is solid).
  const cx = Math.min(Math.max(x, min + r), max - r);
  const cy = Math.min(Math.max(y, min + r), max - r);
  const dx = x - cx;
  const dy = y - cy;
  if (dx * dx + dy * dy > r * r) return null;

  // "C": a ring with a right-facing gap.
  const mx = x - size / 2;
  const my = y - size / 2;
  const dist = Math.hypot(mx, my);
  const outer = size * 0.3;
  const inner = size * 0.17;
  if (dist <= outer && dist >= inner) {
    const angle = Math.atan2(my, mx); // 0 = pointing right
    if (Math.abs(angle) > Math.PI * 0.3) return FG;
  }
  return BG;
}

function renderRGBA(size) {
  const out = Buffer.alloc(size * size * 4);
  const ss = 2; // supersampling factor
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = sample(x + (sx + 0.5) / ss, y + (sy + 0.5) / ss, size);
          if (px) {
            r += px[0];
            g += px[1];
            b += px[2];
            a += px[3];
          }
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      out[i] = Math.round(r / n);
      out[i + 1] = Math.round(g / n);
      out[i + 2] = Math.round(b / n);
      out[i + 3] = Math.round(a / n);
    }
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // Raw scanlines, filter byte 0 per row.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  const file = join(root, `icon-${size}.png`);
  writeFileSync(file, encodePNG(renderRGBA(size), size));
  console.log(`wrote ${file}`);
}
