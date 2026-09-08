// make-icon — rasterise the Starball Lab mark into the app's icons with no dependencies:
//   tray.png (16px) + tray@2x.png (32px)  — the ball on transparent, for the tray
//   icon.png (256px) + icon.ico (16…256)  — the same ball, for the window, taskbar and shortcut
// The mark ("starball · seams"): a white ball whose panels are stars — a pentagon star in the
// middle and five stars touching the rim, in navy, with a navy outline. Same 100-unit geometry as
// the title-bar SVG in widget/index.html. Drawn analytically (point-in-polygon + ring distance)
// with supersampled coverage, written as RGBA PNGs via node:zlib; the .ico wraps the PNGs.
//
//   node widget/make-icon.mjs

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const NAVY = [0x07, 0x0b, 0x1f], WHITE = [0xff, 0xff, 0xff];

// a 5-point star as a 10-vertex polygon (outer radius ro, inner ri), centred at (cx, cy)
function star(cx, cy, ro, ri = ro * 0.42, rot = -90) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? ro : ri, a = (rot + i * 36) * Math.PI / 180;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}
function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// geometry in 100-unit space
const BALL_R = 46, OUTLINE = 3;
const CENTRE = star(50, 50, 22, 12);
// rim stars point outward so a single tip meets the outline (two tips straddling it leave slivers)
const RIM = Array.from({ length: 5 }, (_, k) => { const deg = 90 + k * 72, a = deg * Math.PI / 180; return star(50 + 36 * Math.cos(a), 50 + 36 * Math.sin(a), 18, 18 * 0.42, deg); });

// ink at a point: navy (stars, outline), white (ball), or null (outside)
function hit(x, y) {
  const d = Math.hypot(x - 50, y - 50);
  if (d > BALL_R + OUTLINE / 2) return null;
  if (d > BALL_R - OUTLINE / 2) return "navy";
  if (inPoly(x, y, CENTRE) || RIM.some((p) => inPoly(x, y, p))) return "navy";
  return "white";
}
function raster(size, ss = 8) {
  const px = new Uint8Array(size * size * 4);
  const k = 100 / size;
  const col = { navy: NAVY, white: WHITE };
  for (let py = 0; py < size; py++) for (let pxi = 0; pxi < size; pxi++) {
    let n = 0, r = 0, g = 0, b = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const h = hit((pxi + (sx + 0.5) / ss) * k, (py + (sy + 0.5) / ss) * k);
      if (!h) continue;
      n++; r += col[h][0]; g += col[h][1]; b += col[h][2];
    }
    const o = (py * size + pxi) * 4;
    if (n) { px[o] = r / n; px[o + 1] = g / n; px[o + 2] = b / n; px[o + 3] = Math.round(255 * n / (ss * ss)); }
  }
  return px;
}

// --- PNG + ICO writers ---
const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
// an .ico is a directory of images; Vista+ accepts PNG-compressed entries, which keeps it small
function ico(entries) {
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  const dirs = [], blobs = [];
  for (const { size, data } of entries) {
    const d = Buffer.alloc(16);
    d[0] = size >= 256 ? 0 : size; d[1] = size >= 256 ? 0 : size; d[2] = 0; d[3] = 0;
    d.writeUInt16LE(1, 4); d.writeUInt16LE(32, 6); d.writeUInt32LE(data.length, 8); d.writeUInt32LE(offset, 12);
    dirs.push(d); blobs.push(data); offset += data.length;
  }
  return Buffer.concat([head, ...dirs, ...blobs]);
}

writeFileSync(join(HERE, "tray.png"), png(16, raster(16)));
writeFileSync(join(HERE, "tray@2x.png"), png(32, raster(32)));
writeFileSync(join(HERE, "icon.png"), png(256, raster(256)));
writeFileSync(join(HERE, "icon.ico"), ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: png(size, raster(size)) }))));
console.log("wrote widget/tray.png, tray@2x.png, icon.png, icon.ico");
