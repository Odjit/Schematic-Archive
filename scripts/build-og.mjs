#!/usr/bin/env node
/**
 * build-og.mjs
 *
 * Generates the default OG share image at public/og-default.png from a
 * source banner saved at public/og-source.png. Crops to 1200x630 and
 * composites "THE SCHEMATIC / ARCHIVE" wordmark on the empty left half
 * of the frame.
 *
 * Run:   pnpm og
 *
 * Re-run any time the source banner or wordmark layout changes.
 *
 * Font note: this uses sharp + librsvg to rasterize the wordmark SVG.
 * librsvg looks up the font family from your system fontconfig. If you
 * have Cinzel installed locally, it will be used; otherwise it falls
 * back to Georgia / serif. The site font is loaded from Google Fonts
 * at runtime, so the live site is unaffected by what is installed here.
 * For pixel-perfect Cinzel in this image, install Cinzel locally or
 * swap to a path-based SVG produced in an image editor.
 */

import sharp from 'sharp';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = join(ROOT, 'public', 'og-source.png');
const DEST = join(ROOT, 'public', 'og-default.png');

if (!existsSync(SRC)) {
  console.error('[build-og] missing source image');
  console.error(`         expected at: ${SRC}`);
  console.error('         Save the framed banner there, then re-run.');
  process.exit(1);
}

// The wordmark sits in the left half of the frame. Numbers tuned to land
// inside the gold border with comfortable margin.
const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <g font-family="Cinzel, Georgia, 'Times New Roman', serif" text-anchor="middle">
    <!-- Eyebrow -->
    <text x="360" y="265"
          font-size="38" letter-spacing="6"
          font-weight="500" fill="#c8a14a">THE SCHEMATIC</text>

    <!-- Wordmark -->
    <text x="360" y="365"
          font-size="92" letter-spacing="10"
          font-weight="700" fill="#f5f1eb">ARCHIVE</text>

    <!-- Tagline -->
    <text x="360" y="415"
          font-size="20" letter-spacing="2"
          font-weight="400" fill="#cfc6b8">community castle blueprints for V Rising</text>
  </g>
</svg>`;

const meta = await sharp(SRC).metadata();
console.log(`[build-og] source ${meta.width}x${meta.height}`);

await sharp(SRC)
  .resize(1200, 630, { fit: 'cover', position: 'center' })
  .composite([{ input: Buffer.from(overlay), top: 0, left: 0 }])
  .png({ compressionLevel: 9 })
  .toFile(DEST);

const out = await sharp(DEST).metadata();
console.log(`[build-og] wrote ${DEST} (${out.width}x${out.height})`);
