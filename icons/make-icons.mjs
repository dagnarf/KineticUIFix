// Dep-free PNG icon generator (Node zlib only) — the offline fallback.
// NOTE: the SHIPPED icons (icons/icon{16,32,48,128}.png) are now the polished,
// gradient + check-badge design rendered by ../store/render-assets.mjs (headless
// Chrome), which also produces the store listing art. Re-running THIS script will
// overwrite them with the simpler flat design; prefer `npm run store-assets`.
// No external deps: builds valid RGBA PNGs with Node's zlib. Run: `node icons/make-icons.mjs`.
// Design: rounded blue tile with a white "grid" glyph (three rows) and a green check corner,
// signalling "grid is fixed". Re-runnable; output bytes are stable for a given size.

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

const BG = [0x1f, 0x6f, 0xeb, 0xff]; // brand blue
const FG = [0xff, 0xff, 0xff, 0xff]; // white grid lines
const OK = [0x2e, 0xa0, 0x43, 0xff]; // green accent
const CLEAR = [0x00, 0x00, 0x00, 0x00];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "latin1");
  const body = Buffer.concat([typeBuf, data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixels) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y += 1) {
    raw[o] = 0; // no filter
    o += 1;
    for (let x = 0; x < size; x += 1) {
      const p = pixels[y * size + x];
      raw[o] = p[0];
      raw[o + 1] = p[1];
      raw[o + 2] = p[2];
      raw[o + 3] = p[3];
      o += 4;
    }
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function buildPixels(size) {
  const px = new Array(size * size).fill(CLEAR);
  const r = Math.max(2, Math.round(size * 0.18)); // corner radius
  const inCorner = (x, y) => {
    // round the four corners of the tile
    const cx = x < r ? r - x : x >= size - r ? x - (size - r - 1) : 0;
    const cy = y < r ? r - y : y >= size - r ? y - (size - r - 1) : 0;
    return cx * cx + cy * cy <= r * r;
  };
  // tile background
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (inCorner(x, y)) {
        px[y * size + x] = BG;
      }
    }
  }
  // grid glyph: three horizontal bars inside an inset frame
  const inset = Math.round(size * 0.24);
  const right = size - inset;
  const bottom = size - inset;
  const lineW = Math.max(1, Math.round(size * 0.07));
  const span = bottom - inset;
  const rows = [inset, inset + Math.round(span * 0.5) - Math.round(lineW / 2), bottom - lineW];
  const set = (x, y, color) => {
    if (x >= 0 && y >= 0 && x < size && y < size && inCorner(x, y)) {
      px[y * size + x] = color;
    }
  };
  for (const ry of rows) {
    for (let dy = 0; dy < lineW; dy += 1) {
      for (let x = inset; x < right; x += 1) {
        set(x, ry + dy, FG);
      }
    }
  }
  // a single vertical divider to read as a "grid"
  const vx = inset + Math.round((right - inset) * 0.42);
  for (let dx = 0; dx < lineW; dx += 1) {
    for (let y = inset; y < bottom; y += 1) {
      set(vx + dx, y, FG);
    }
  }
  // green "fixed" dot in the lower-right corner
  const dotR = Math.max(2, Math.round(size * 0.16));
  const dcx = size - dotR - Math.round(size * 0.08);
  const dcy = size - dotR - Math.round(size * 0.08);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const ddx = x - dcx;
      const ddy = y - dcy;
      if (ddx * ddx + ddy * ddy <= dotR * dotR) {
        px[y * size + x] = OK;
      }
    }
  }
  return px;
}

for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, buildPixels(size));
  const out = join(HERE, `icon${size}.png`);
  writeFileSync(out, png);
  process.stdout.write(`wrote ${out} (${png.length} bytes)\n`);
}
