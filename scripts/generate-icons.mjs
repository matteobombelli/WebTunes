// Regenerates the raster icons (favicon, apple-icon, PWA icons) from lucide's eighth-notes glyph,
// drawn in white on the accent colour. Same template as the other matteob.dev apps, so the
// subdomains read as one family (rounded square, white stroke glyph).
// Run: node scripts/generate-icons.mjs
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const BG = "#7c3aed"; // violet
const FG = "#ffffff";
// lucide eighth-notes (24x24 viewBox, stroke-based).
const GLYPH =
  `<path d="M21 16V3a1 1 0 0 0-1.28-.96l-10 2.917a1 1 0 0 0-.72.96V19"/>` +
  `<circle cx="18" cy="16" r="3"/><circle cx="6" cy="19" r="3"/>`;

/**
 * SVG for a square icon. `glyphShare` is the glyph's share of the tile; maskable icons keep it
 * inside the central safe zone. `rounded` cuts transparent corners; maskable and Apple icons are
 * full-bleed because the platform applies its own mask.
 */
function svg(size, { glyphShare = 0.62, rounded = true } = {}) {
  const scale = (size * glyphShare) / 24;
  const offset = (size - 24 * scale) / 2;
  const radius = rounded ? size * 0.22 : 0;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
      `<rect width="${size}" height="${size}" rx="${radius}" fill="${BG}"/>` +
      `<g transform="translate(${offset} ${offset}) scale(${scale})" fill="none" stroke="${FG}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${GLYPH}</g>` +
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
await writeFile(join(ROOT, "public/icon-512-maskable.png"), await png(512, { glyphShare: 0.5, rounded: false }));
await writeFile(join(ROOT, "src/app/apple-icon.png"), await png(180, { rounded: false }));
const ico = await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await png(size) })));
await writeFile(join(ROOT, "src/app/favicon.ico"), buildIco(ico));
console.log("Generated icon-192, icon-512, icon-512-maskable, apple-icon, favicon.ico");
