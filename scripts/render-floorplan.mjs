#!/usr/bin/env node
/**
 * render-floorplan.mjs
 *
 * Reads a .kindredschematic (JSON) and produces a top-down SVG floor plan.
 *
 * - Used by build-index.mjs at site-build time to auto-generate
 *   dist/entry-assets/<slug>/floorplan.svg for every build that ships a
 *   real schematic file.
 * - Also runnable from the CLI for ad-hoc previews:
 *
 *     node scripts/render-floorplan.mjs path/to/x.schematic out.svg
 *
 * Coordinate model
 * ----------------
 * V Rising schematics use a curious mixed coordinate system:
 *   - boundingBox.min/max  is [tileX, worldY, tileZ]   (X/Z are tile indices,
 *                                                       Y is world meters)
 *   - entity.tilePos       is [tileX, tileZ]
 *   - entity.pos           is [worldX, worldY, worldZ] (meters)
 *   - entity.rot           is Euler degrees [xDeg, yDeg, zDeg]
 *     (see KindredSchematics/JsonConverters/QuaternionConverter.cs — the
 *      stored quaternion is converted to Euler at save-time)
 *
 * We render in tile space. The footprint of each placed entity is taken
 * from its prefab's PhysicsCollider AABB (carried on render-prefabs.json),
 * sized in tiles where 1 tile = 1 meter on V Rising's build grid. Walls
 * come out ~5x1, floors ~6x6, stairs ~6x7, etc.
 *
 * Rotation: the entity's `rot` Y component is rounded to the nearest 90°.
 * 0/180 keeps the AABB as-is; 90/270 swaps W and D so a wall rotated
 * 90 degrees draws along Z instead of X.
 *
 * Prefabs that lack a usable AABB (chains attached via parent, decorations
 * with no collider) fall back to a 1x1 marker — visually distinct from real
 * structural pieces, which is honest about uncertainty.
 *
 * Z-stacking
 * ----------
 * SVG paints in document order. We draw layers from "ground" to "feature"
 * so the eye picks out structure first, then content:
 *
 *   floor   < wall < stairs/door < decor < workstation/storage/coffin
 *           < light/plant < teleporter < heart
 *
 * Each layer also collapses identical (cell, color) pairs to one rect, so
 * a 200-tile castle with three floors of stacked walls doesn't bloat the
 * SVG with redundant geometry.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, basename, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  LAYER_ORDER,
  buildCategoryLookup,
  detectFloors,
  buildPanel,
} from '../src/lib/floorplan.mjs';

/**
 * @param {object} schematic   parsed .kindredschematic JSON
 * @param {object} prefabTable parsed render-prefabs.json
 * @param {object} [opts]
 * @param {number} [opts.targetWidth=800]  max SVG width in px
 * @param {number} [opts.minCell=2]        minimum cell size in px
 * @param {number} [opts.maxCell=8]        maximum cell size in px
 * @param {boolean} [opts.slices=true]     emit per-floor slices below the merged view
 * @returns {{ svg: string, stats: object }}
 */
export function renderFloorplan(schematic, prefabTable, opts = {}) {
  const targetWidth   = opts.targetWidth ?? 800;
  const minCell       = opts.minCell     ?? 2;
  const maxCell       = opts.maxCell     ?? 8;
  const wantSlices    = opts.slices      ?? true;

  const lookup = buildCategoryLookup(prefabTable);

  // -- 1. Tile-coord extent + cell sizing (shared across all panels).
  const bbMin = schematic.boundingBox?.min ?? [0, 0, 0];
  const bbMax = schematic.boundingBox?.max ?? [0, 0, 0];
  const minTX = Math.floor(bbMin[0]);
  const minTZ = Math.floor(bbMin[2]);
  const maxTX = Math.ceil(bbMax[0]);
  const maxTZ = Math.ceil(bbMax[2]);
  const tilesW = Math.max(1, maxTX - minTX);
  const tilesD = Math.max(1, maxTZ - minTZ);
  const cell = Math.max(minCell, Math.min(maxCell, Math.floor(targetWidth / tilesW)));
  const drawW = tilesW * cell;
  const drawH = tilesD * cell;
  const geom = { minTX, maxTZ, cell };

  // -- 2. Build panels: merged on top, slices below (when >=2 floors).
  const bands = wantSlices ? detectFloors(schematic) : [];
  const panels = [];
  panels.push({
    label: bands.length > 0 ? 'All floors merged' : 'Floor plan',
    sublabel: null,
    panel: buildPanel(schematic.entities, lookup, geom, null),
  });
  for (const band of bands) {
    panels.push({
      label: band.label,
      sublabel: band.yRangeStr,
      panel: buildPanel(schematic.entities, lookup, geom, band),
    });
  }

  // -- 3. Compose SVG: stacked panels with per-panel titles, shared legend.
  const PAD       = 8;
  const TITLE_H   = 22;
  const LEGEND_H  = 26;
  const PANEL_GAP = 14;
  const panelHeight = TITLE_H + drawH;
  const stackHeight = panels.length * panelHeight + (panels.length - 1) * PANEL_GAP;

  const svgW = drawW + PAD * 2;
  const svgH = PAD * 2 + stackHeight + LEGEND_H;

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" ` +
    `viewBox="0 0 ${svgW} ${svgH}" role="img" aria-label="Floor plan">`
  );
  parts.push(`<rect width="${svgW}" height="${svgH}" fill="#f3ede0"/>`);

  // Each panel: title strip + plot area.
  let cursorY = PAD;
  for (const { label, sublabel, panel } of panels) {
    // Title.
    parts.push(
      `<g transform="translate(${PAD} ${cursorY})" font-family="system-ui, sans-serif" fill="#3a3024">` +
      `<text y="14" font-size="13" font-weight="600">${escapeXml(label)}</text>` +
      (sublabel
        ? `<text x="${drawW}" y="14" font-size="11" text-anchor="end" fill="#7a6c52">${escapeXml(sublabel)} · ${panel.placed} entities</text>`
        : `<text x="${drawW}" y="14" font-size="11" text-anchor="end" fill="#7a6c52">${panel.placed} entities</text>`) +
      `</g>`
    );
    const plotY = cursorY + TITLE_H;
    parts.push(
      `<rect x="${PAD}" y="${plotY}" width="${drawW}" height="${drawH}" ` +
      `fill="#ece2cc" stroke="#a89878" stroke-width="1"/>`
    );
    parts.push(`<g transform="translate(${PAD} ${plotY})">`);
    for (const layerId of LAYER_ORDER) {
      const bucket = panel.layers.get(layerId);
      if (!bucket || bucket.size === 0) continue;
      const color = (prefabTable.categories.find(c => c.id === layerId)?.color) ?? '#888';
      parts.push(`<g data-layer="${layerId}" fill="${color}">`);
      for (const { sx, sy, w, d } of bucket.values()) {
        parts.push(`<rect x="${sx}" y="${sy}" width="${w * cell}" height="${d * cell}"/>`);
      }
      parts.push(`</g>`);
    }
    parts.push(`</g>`);

    cursorY += panelHeight + PANEL_GAP;
  }

  // -- 4. Shared legend at the bottom (uses combined category counts across
  // all panels' merged view — same as just using the merged panel's counts).
  const mergedCounts = panels[0].panel.counts;
  const usedCats = LAYER_ORDER.filter(id => (mergedCounts.get(id) ?? 0) > 0);
  parts.push(
    `<g transform="translate(${PAD} ${PAD + stackHeight + 6})" ` +
    `font-family="system-ui, sans-serif" font-size="10" fill="#3a3024">`
  );
  let lx = 0;
  for (const id of usedCats) {
    const cat = prefabTable.categories.find(c => c.id === id);
    if (!cat) continue;
    const label = `${cat.label} (${mergedCounts.get(id)})`;
    const textW = label.length * 5.6 + 18;
    parts.push(
      `<rect x="${lx}" y="0" width="10" height="10" fill="${cat.color}"/>` +
      `<text x="${lx + 14}" y="9">${escapeXml(label)}</text>`
    );
    lx += textW + 6;
    if (lx > drawW - 60) break;
  }
  parts.push(`</g>`);
  parts.push(`</svg>`);

  // -- 5. Stats: keep the same top-level shape as before so the caller's
  // log line keeps working, plus a `slices` array for slice-aware callers.
  const merged = panels[0].panel;
  return {
    svg: parts.join(''),
    stats: {
      tilesW, tilesD, cell,
      placed: merged.placed,
      skippedNoTile: merged.skippedNoTile,
      unknownPrefabs: merged.unknown,
      unknownSample: [...merged.unknownSample].slice(0, 8),
      perCategory: Object.fromEntries(
        [...merged.counts.entries()].sort((a, b) => b[1] - a[1])
      ),
      slices: panels.slice(1).map((p, i) => ({
        floorIndex: i,
        label: p.label,
        yRange: p.sublabel,
        placed: p.panel.placed,
      })),
    },
  };
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// CLI:  node scripts/render-floorplan.mjs <schematic> [out.svg]
// ---------------------------------------------------------------------------
async function cli() {
  const [schemaArg, outArg] = process.argv.slice(2);
  if (!schemaArg) {
    console.error('usage: node scripts/render-floorplan.mjs <schematic> [out.svg]');
    process.exit(1);
  }
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = resolve(__dirname, '..');
  const tablePath = resolve(root, 'src/data/render-prefabs.json');
  const schemaPath = resolve(process.cwd(), schemaArg);
  const outPath = outArg
    ? resolve(process.cwd(), outArg)
    : resolve(process.cwd(), basename(schemaArg).replace(/\.[^.]+$/, '') + '.svg');

  const [tableJson, schemaJson] = await Promise.all([
    readFile(tablePath, 'utf8'),
    readFile(schemaPath, 'utf8'),
  ]);
  const table = JSON.parse(tableJson);
  const schema = JSON.parse(schemaJson);

  const { svg, stats } = renderFloorplan(schema, table);
  await writeFile(outPath, svg);

  console.log(`wrote ${outPath}`);
  console.log(`  tiles: ${stats.tilesW} x ${stats.tilesD}  cell: ${stats.cell}px`);
  console.log(`  placed: ${stats.placed}   no-tilePos: ${stats.skippedNoTile}   unknown-prefabs: ${stats.unknownPrefabs}`);
  if (stats.slices.length) {
    console.log(`  slices:`);
    for (const s of stats.slices) {
      console.log(`    ${s.label.padEnd(8)} ${s.yRange ?? ''}   ${s.placed} entities`);
    }
  }
  if (stats.unknownSample.length) {
    console.log(`  unknown sample: ${stats.unknownSample.join(', ')}`);
  }
  console.log(`  per-category:`);
  for (const [k, v] of Object.entries(stats.perCategory)) {
    console.log(`    ${k.padEnd(12)} ${v}`);
  }
}

// Run CLI only when invoked directly (not when imported by build-index.mjs).
// Use pathToFileURL because Windows file:// URLs have an extra slash that
// breaks a naïve string compare against process.argv[1].
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
