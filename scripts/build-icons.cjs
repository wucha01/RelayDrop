'use strict';
// Source-authored SVG; no external image, EXIF, personal artwork or signing data.
const fs = require('node:fs/promises'), path = require('node:path');
const sharp = require('sharp');
async function main() {
  const assets = path.resolve(__dirname, '../desktop/assets');
  const svg = await fs.readFile(path.join(assets, 'icon.svg'));
  await sharp(svg).resize(512, 512).png().toFile(path.join(assets, 'icon.png'));
  const sizes = [16, 24, 32, 48, 64, 128, 256], images = [];
  for (const size of sizes) images.push(await sharp(svg).resize(size, size).png().toBuffer());
  const header = Buffer.alloc(6 + 16 * sizes.length); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  images.forEach((image, i) => {
    const p = 6 + 16 * i; header[p] = header[p + 1] = sizes[i] % 256;
    header.writeUInt16LE(1, p + 4); header.writeUInt16LE(32, p + 6);
    header.writeUInt32LE(image.length, p + 8); header.writeUInt32LE(offset, p + 12); offset += image.length;
  });
  await fs.writeFile(path.join(assets, 'icon.ico'), Buffer.concat([header, ...images]));
  console.log('Generated desktop PNG and multi-resolution ICO from icon.svg.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
