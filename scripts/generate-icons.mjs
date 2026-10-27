// Regenerates the brand raster icons (favicon, apple-icon, PWA icons) from the in-app MusicIcon
// glyph in the indigo accent.
// Same template as the other matteob.dev apps, so the subdomains read as one family: a
// near-black tile with a pastel glyph centred on its visual weight.
// Run: node scripts/generate-icons.mjs
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const FG = "#818cf8"; // accent-bright (indigo-400)
// The MusicIcon path from src/components/icons.tsx (24x24 viewBox, filled).
const GLYPH =
  `<path d="M9 5.5a1 1 0 0 1 .76-.97l8-2A1 1 0 0 1 19 3.5V15a3 3 0 1 1-2-2.83V6.78l-6 1.5V17a3 3 0 1 1-2-2.83V5.5z"/>`;
const GLYPH_STYLE = `fill="${FG}"`;

const BG = "#141417"; // near-black tile shared by every matteob.dev app

// Glyph metrics, measured once from a raster of the glyph alone: its bounding box and its
// alpha-weighted centroid, in 24-grid units. The glyph is scaled by its box so every app's glyph
// has the same visual size, and placed by its centroid so the tile is centred on the glyph's
// weight rather than its box (a music note's mass sits right of its box, for instance).
const METRICS = await measureGlyph();

async function measureGlyph() {
  const px = 32; // raster pixels per grid unit
  const n = 24 * px;
  const markup =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 24 24">` +
    `<g ${GLYPH_STYLE}>${GLYPH}</g></svg>`;
  const { data, info } = await sharp(Buffer.from(markup))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  let sx = 0;
  let sy = 0;
  let minX = n;
  let minY = n;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const a = data[(y * info.width + x) * info.channels + 3];
      if (a === 0) continue;
      sum += a;
      sx += a * x;
      sy += a * y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return {
    cx: sx / sum / px,
    cy: sy / sum / px,
    width: (maxX - minX + 1) / px,
    height: (maxY - minY + 1) / px,
  };
}

const num = (v) => String(Math.round(v * 1000) / 1000);

/**
 * SVG for a square icon. `glyphShare` is the glyph's share of the tile (by its longer side);
 * maskable icons keep it inside the central safe zone. `rounded` cuts transparent corners;
 * maskable and Apple icons are full-bleed because the platform applies its own mask.
 */
function svg(size, { glyphShare = 0.6, rounded = true } = {}) {
  const scale = (size * glyphShare) / Math.max(METRICS.width, METRICS.height);
  const radius = rounded ? size * 0.22 : 0;
  const tx = size / 2 - METRICS.cx * scale;
  const ty = size / 2 - METRICS.cy * scale;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
      `<rect width="${size}" height="${size}" rx="${num(radius)}" fill="${BG}"/>` +
      `<g transform="translate(${num(tx)} ${num(ty)}) scale(${num(scale)})" ${GLYPH_STYLE}>${GLYPH}</g>` +
      `</svg>`,
  );
}

function png(size, options) {
  return sharp(svg(size, options)).ensureAlpha().png().toBuffer();
}

/** A .ico embedding PNG images (32-bit RGBA). */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size, 0);
    entry.writeUInt8(size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

await writeFile(join(ROOT, "public/icon-192.png"), await png(192));
await writeFile(join(ROOT, "public/icon-512.png"), await png(512));
await writeFile(join(ROOT, "public/icon-512-maskable.png"), await png(512, { glyphShare: 0.44, rounded: false }));
await writeFile(join(ROOT, "src/app/apple-icon.png"), await png(180, { rounded: false }));
const ico = await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await png(size) })));
await writeFile(join(ROOT, "src/app/favicon.ico"), buildIco(ico));
console.log("Generated icon-192, icon-512, icon-512-maskable, apple-icon, favicon.ico");
