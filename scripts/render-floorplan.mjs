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

// ---------------------------------------------------------------------------
// Layer order — paint earliest first, latest last. The reader's eye should
// pick out:
//   - the FLOOR plan first (ground tier)
//   - then ambient decor and plants (filler)
//   - then STRUCTURE — walls, stairs, doors — these define the shape
//   - then interactive CONTENT markers (workstations, storage, coffins)
//   - then HEART last so it's always visible
// ---------------------------------------------------------------------------
const LAYER_ORDER = [
  // ground
  'floor',
  'floor-decor',
  // ambient filler — won't obscure structure
  'decoration',
  'plant',
  'fence',
  'wall-decor',
  'roof',
  // structural skeleton — must read clearly
  'wall',
  'stairs',
  'door',
  // interactive content markers
  'storage',
  'workstation',
  'coffin',
  'light',
  'teleporter',
  'other',
  // always on top
  'heart',
];

const UNKNOWN_CATEGORY = 'other';

// Footprint used when a prefab has no AABB in the table (chains, particle-only
// markers, etc.). Small enough to read as "I don't know what this is" rather
// than swamping the structural layers.
const FALLBACK_W  = 1;
const FALLBACK_D  = 1;
const FALLBACK_Y0 = 0;
const FALLBACK_Y1 = 1;

// V Rising's castle build grid: each floor is 5 m tall. Slice bands are
// (floor_y, floor_y + FLOOR_HEIGHT_M). Bands below are derived from the
// schematic's boundingBox.min.y so a build that starts above the standard
// 5 m ground (e.g. on a hilltop terrain) still slices cleanly.
const FLOOR_HEIGHT_M = 5;

// A slice slightly overlaps its neighbour bands so pieces sitting exactly on
// a floor boundary (e.g. floor tiles at Y = 10 with thickness ~0.02 m) don't
// drop out of either band due to floating-point comparison.
const SLICE_EDGE_EPS = 0.05;

// ---------------------------------------------------------------------------
function buildCategoryLookup(prefabTable) {
  const byCategory = new Map(prefabTable.categories.map(c => [c.id, c]));
  return {
    /** name -> {category, color, w, d, y0, y1, known} */
    lookup(prefabName) {
      const entry = prefabTable.prefabs[prefabName];
      const id = entry?.category ?? UNKNOWN_CATEGORY;
      const meta = byCategory.get(id) ?? byCategory.get(UNKNOWN_CATEGORY);
      return {
        id,
        color: meta.color,
        label: meta.label,
        w:  entry?.w  ?? FALLBACK_W,
        d:  entry?.d  ?? FALLBACK_D,
        y0: entry?.y0 ?? FALLBACK_Y0,
        y1: entry?.y1 ?? FALLBACK_Y1,
        known: !!entry,
      };
    },
    categories: prefabTable.categories,
  };
}

/**
 * Map an entity's Y-axis Euler rotation (in degrees) to one of the four
 * cardinal orientations. Anything not a clean multiple of 90 snaps to the
 * nearest. Returns true when the piece is rotated 90 or 270 — meaning W and
 * D should be swapped.
 */
function swapsWidthDepth(rotEulerDeg) {
  if (!Array.isArray(rotEulerDeg)) return false;
  const y = rotEulerDeg[1] ?? 0;
  // Normalize to [0, 360) then to nearest 90.
  const norm = ((Math.round(y / 90) * 90) % 360 + 360) % 360;
  return norm === 90 || norm === 270;
}

// ---------------------------------------------------------------------------
/**
 * Detect floor slice bands from the schematic's bounding box.
 *
 * Returns an array of {y0, y1, label, floorIndex} bands covering the Y range.
 * Each band is FLOOR_HEIGHT_M tall, anchored at bbMin.y. The first band is
 * "Ground", subsequent bands are "Floor 2 / 3 / ...". When the topmost band
 * is short and dominated by roof pieces, we still emit it as a "Roof" band.
 */
function detectFloors(schematic) {
  const bbMin = schematic.boundingBox?.min ?? [0, 0, 0];
  const bbMax = schematic.boundingBox?.max ?? [0, 0, 0];
  const yMin = bbMin[1];
  const yMax = bbMax[1];
  const range = Math.max(0, yMax - yMin);
  if (range <= FLOOR_HEIGHT_M * 0.6) return []; // single-floor build: no slices

  const count = Math.max(1, Math.ceil(range / FLOOR_HEIGHT_M));
  const bands = [];
  for (let i = 0; i < count; i++) {
    const y0 = yMin + i * FLOOR_HEIGHT_M;
    const y1 = y0 + FLOOR_HEIGHT_M;
    let label;
    if (i === 0) label = 'Ground';
    else if (i === count - 1 && count >= 3) label = 'Roof';
    else label = `Floor ${i + 1}`;
    bands.push({
      y0, y1, label, floorIndex: i,
      yRangeStr: `${Math.round(y0)}–${Math.round(y1)} m`,
    });
  }
  return bands;
}

/**
 * Walk the entities once and produce the per-layer rect buckets for one
 * panel. `yFilter` is null for the merged view, or {y0, y1} to keep only
 * entities whose vertical extent overlaps the band.
 *
 * @returns {{ layers: Map<string, Map>, counts: Map<string, number>, placed: number, unknown: number, unknownSample: Set<string>, skippedNoTile: number }}
 */
function buildPanel(entities, lookup, geom, yFilter) {
  const layers = new Map();
  for (const id of LAYER_ORDER) layers.set(id, new Map());
  const counts = new Map();
  const unknownSample = new Set();
  let placed = 0;
  let unknown = 0;
  let skippedNoTile = 0;
  let skippedByBand = 0;

  for (const e of entities ?? []) {
    if (!e.tilePos) { skippedNoTile++; continue; }
    const cls = lookup.lookup(e.prefab);
    if (!cls.known) {
      unknown++;
      if (unknownSample.size < 16) unknownSample.add(e.prefab);
    }

    // Y-band filtering. We use the entity's *center Y* with closed-open
    // band semantics: an entity belongs to band [b0, b1) if its center
    // satisfies b0 <= centerY < b1. Why center rather than overlap:
    //
    //   - A floor tile (y1 - y0 ~= 0.02 m) sitting at pos.y = 10 has its
    //     center at 10.01, which lands cleanly in band [10, 15). An
    //     overlap test would either drop it (epsilon too strict) or
    //     double-count it into [5, 10) (epsilon too loose).
    //   - A wall (5 m tall) at pos.y = 10 has its center at 12.5, which
    //     lands in [10, 15) — its own floor, not the one below.
    //   - Stair pieces split into Lower/Upper variants in the game data;
    //     each flight's center sits in its own floor band, so transitions
    //     read naturally without artificial double-rendering.
    if (yFilter) {
      const py = e.pos?.[1] ?? 0;
      const centerY = py + (cls.y0 + cls.y1) / 2;
      if (centerY < yFilter.y0 || centerY >= yFilter.y1) { skippedByBand++; continue; }
    }

    const layerId = layers.has(cls.id) ? cls.id : UNKNOWN_CATEGORY;
    const bucket = layers.get(layerId);

    let w = cls.w;
    let d = cls.d;
    if (swapsWidthDepth(e.rot)) { [w, d] = [d, w]; }

    const sx = (e.tilePos[0] - w / 2 - geom.minTX) * geom.cell;
    const sy = (geom.maxTZ - e.tilePos[1] - d / 2) * geom.cell;
    const key = `${sx},${sy},${w},${d}`;
    bucket.set(key, { sx, sy, w, d });

    placed++;
    counts.set(cls.id, (counts.get(cls.id) ?? 0) + 1);
  }

  return { layers, counts, placed, unknown, unknownSample, skippedNoTile, skippedByBand };
}

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
