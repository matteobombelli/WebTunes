// Regenerates the brand raster icons (favicon, apple-icon, PWA icons) from the
// in-app MusicIcon glyph, rendered in the indigo accent on a dark circular tile.
// Run: node scripts/generate-icons.mjs
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const BG = "#141417"; // surface-1
const FG = "#818cf8"; // accent-bright (indigo-400)
// The MusicIcon path from src/components/icons.tsx (24×24 viewBox).
const GLYPH =
  "M9 5.5a1 1 0 0 1 .76-.97l8-2A1 1 0 0 1 19 3.5V15a3 3 0 1 1-2-2.83V6.78l-6 1.5V17a3 3 0 1 1-2-2.83V5.5z";
// The glyph's bounding box is centred, but its filled mass sits right of centre
// (centroid x ≈ 13.07 of 24), so the geometric centre reads as shifted right.
// Nudge left to the optical centre.
const OPTICAL_DX = 12 - 13.07;

/** SVG buffer for a square icon of the given pixel size. */
function svg(size) {
  const scale = (size * 0.78) / 24; // note occupies ~78% of the tile
  const offset = (size - 24 * scale) / 2;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
      `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="${BG}"/>` +
      `<g transform="translate(${offset} ${offset}) scale(${scale}) translate(${OPTICAL_DX} 0)" fill="${FG}">` +
      `<path d="${GLYPH}"/></g></svg>`,
  );
}

/** RGBA PNG buffer at the given size. */
function png(size) {
  return sharp(svg(size)).ensureAlpha().png().toBuffer();
}

/** Assemble a .ico embedding PNG images (RGBA / 32-bit). */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  const blobs = [];
  let offset = 6 + images.length * 16;
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
    entry.writeUInt8(0, 2); // palette
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel (RGBA)
    entry.writeUInt32LE(data.length, 8); // size of image data
    entry.writeUInt32LE(offset, 12); // offset
    offset += data.length;
    entries.push(entry);
    blobs.push(data);
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

async function main() {
  await writeFile(join(ROOT, "public/icon-192.png"), await png(192));
  await writeFile(join(ROOT, "public/icon-512.png"), await png(512));
  await writeFile(join(ROOT, "src/app/apple-icon.png"), await png(180));

  const icoImages = await Promise.all(
    [16, 32, 48].map(async (size) => ({ size, data: await png(size) })),
  );
  await writeFile(join(ROOT, "src/app/favicon.ico"), buildIco(icoImages));

  console.log("Generated icon-192, icon-512, apple-icon, favicon.ico");
}

main();
