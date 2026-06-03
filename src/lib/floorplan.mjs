/**
 * floorplan.mjs — pure functions for building a top-down floor plan.
 *
 * Lifted out of `scripts/render-floorplan.mjs` so the SVG renderer (Node,
 * build-time) and the upcoming Canvas viewer (Preact island, browser) can
 * share one source of truth for layer order, prefab classification, Y-band
 * partitioning, and per-entity placement.
 *
 * Nothing in here emits SVG or touches the DOM. Callers decide how to paint
 * the per-layer rect buckets that `buildPanel` returns.
 *
 * Coordinate model (recap — same as the schematic format):
 *   - boundingBox.min/max  is [tileX, worldY, tileZ]  (X/Z = tile indices,
 *                                                      Y = world meters)
 *   - entity.tilePos       is [tileX, tileZ]
 *   - entity.pos           is [worldX, worldY, worldZ]  (meters)
 *   - entity.rot           is Euler degrees [xDeg, yDeg, zDeg]
 *
 * 1 tile = 1 meter on V Rising's castle build grid; the AABB carried on
 * each prefab translates directly to tile units in the plan.
 */

// ---------------------------------------------------------------------------
// Layer order — paint earliest first, latest last. The reader's eye should
// pick out:
//   - the FLOOR plan first (ground tier)
//   - then ambient decor and plants (filler)
//   - then STRUCTURE — walls, stairs, doors — these define the shape
//   - then interactive CONTENT markers (workstations, storage, coffins)
//   - then HEART last so it's always visible
// ---------------------------------------------------------------------------
export const LAYER_ORDER = [
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

export const UNKNOWN_CATEGORY = 'other';

// Categories whose pieces are foundation-style tiles: their PhysicsCollider
// AABB is smaller than the placement grid cell they visually fill (a stone
// floor foundation has a 6 m collider but tiles on a 10 m grid). Rendering
// the collider leaves 4 m gaps on every side, so the floor reads as scattered
// squares instead of a continuous surface. For these categories we render at
// the detected grid pitch instead (see detectGridPitch + buildPanel).
//
// Deliberately NOT including 'roof': filling roof blockers to the cell would
// lay a solid sheet over the lower floors in the top-down merged view,
// obscuring the very plan we're trying to show.
export const FULL_CELL_CATEGORIES = new Set(['floor']);

// Footprint used when a prefab has no AABB in the table (chains, particle-only
// markers, etc.). Small enough to read as "I don't know what this is" rather
// than swamping the structural layers.
export const FALLBACK_W  = 1;
export const FALLBACK_D  = 1;
export const FALLBACK_Y0 = 0;
export const FALLBACK_Y1 = 1;

// V Rising's castle build grid: each floor is 5 m tall. Slice bands are
// (floor_y, floor_y + FLOOR_HEIGHT_M). Bands below are derived from the
// schematic's boundingBox.min.y so a build that starts above the standard
// 5 m ground (e.g. on a hilltop terrain) still slices cleanly.
export const FLOOR_HEIGHT_M = 5;

// Reserved for future overlap-mode Y filtering: when the continuous Y-slider
// in the Canvas viewer wants to keep an entity visible while its vertical
// extent overlaps the band by at least this much. Unused in 'center' mode,
// which is what the static SVG renderer always uses.
export const SLICE_EDGE_EPS = 0.05;

// ---------------------------------------------------------------------------
// Default panel sizing — chosen to fit the typical desktop floor plan into
// ~800 px without losing readability on dense walls. The cell range carries
// through to drawW/drawH so the canvas/SVG output size scales with the build.
const DEFAULT_TARGET_WIDTH = 800;
const DEFAULT_MIN_CELL     = 2;
const DEFAULT_MAX_CELL     = 8;

/**
 * Compute the shared panel layout for one schematic — tile-coord extent, the
 * derived pixel cell, and the final draw dimensions. Both the SVG renderer
 * and the Canvas viewer call this so cell sizing never drifts between them.
 *
 * The returned `{minTX, maxTZ, cell}` is the `geom` that buildPanel consumes;
 * `{tilesW, tilesD, drawW, drawH}` are the panel size in tile and pixel
 * units, used by the caller to size its own surface.
 *
 * @param {object} schematic parsed .kindredschematic JSON
 * @param {object} [opts]
 * @param {number} [opts.targetWidth=800] target panel width in px; cell is
 *   floor(targetWidth / tilesW), clamped to [minCell, maxCell]
 * @param {number} [opts.minCell=2] minimum cell size in px (keeps thin walls
 *   visible on very wide builds)
 * @param {number} [opts.maxCell=8] maximum cell size in px (caps the pixel
 *   density on tiny builds)
 * @returns {{
 *   minTX: number, maxTZ: number, cell: number,
 *   tilesW: number, tilesD: number,
 *   drawW: number, drawH: number,
 * }}
 */
export function computePanelLayout(schematic, opts = {}) {
  const targetWidth = opts.targetWidth ?? DEFAULT_TARGET_WIDTH;
  const minCell     = opts.minCell     ?? DEFAULT_MIN_CELL;
  const maxCell     = opts.maxCell     ?? DEFAULT_MAX_CELL;

  const bbMin = schematic.boundingBox?.min ?? [0, 0, 0];
  const bbMax = schematic.boundingBox?.max ?? [0, 0, 0];
  const minTX = Math.floor(bbMin[0]);
  const maxTX = Math.ceil(bbMax[0]);
  const maxTZ = Math.ceil(bbMax[2]);
  // minTZ is computed only to derive tilesD — Z origin in the plan is set by
  // maxTZ via the (maxTZ - tilePos[1]) flip inside buildPanel (north-up).
  const minTZ = Math.floor(bbMin[2]);
  const tilesW = Math.max(1, maxTX - minTX);
  const tilesD = Math.max(1, maxTZ - minTZ);
  const cell = Math.max(minCell, Math.min(maxCell, Math.floor(targetWidth / tilesW)));
  const drawW = tilesW * cell;
  const drawH = tilesD * cell;

  return { minTX, maxTZ, cell, tilesW, tilesD, drawW, drawH };
}

// ---------------------------------------------------------------------------
/**
 * Build a name → metadata lookup over the slim prefab table
 * (src/data/render-prefabs.json schema v4).
 *
 * @param {object} prefabTable parsed render-prefabs.json
 * @returns {{
 *   lookup: (prefabName: string) => {
 *     id: string, color: string, label: string,
 *     w: number, d: number, y0: number, y1: number,
 *     known: boolean
 *   },
 *   categories: Array<{ id: string, label: string, color: string }>
 * }}
 */
export function buildCategoryLookup(prefabTable) {
  const byCategory = new Map(prefabTable.categories.map(c => [c.id, c]));
  return {
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
 *
 * @param {number[]} rotEulerDeg
 * @returns {boolean}
 */
export function swapsWidthDepth(rotEulerDeg) {
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
 * Returns an array of {y0, y1, label, floorIndex, yRangeStr} bands covering
 * the Y range. Each band is FLOOR_HEIGHT_M tall, anchored at bbMin.y. The
 * first band is "Ground", subsequent bands are "Floor 2 / 3 / ...". When the
 * topmost band is short and dominated by roof pieces, we still emit it as a
 * "Roof" band.
 *
 * Single-floor builds (Y range < ~0.6 of one floor height) return [] — the
 * caller should skip slicing entirely for those.
 *
 * @param {object} schematic parsed .kindredschematic JSON
 * @returns {Array<{ y0: number, y1: number, label: string, floorIndex: number, yRangeStr: string }>}
 */
export function detectFloors(schematic) {
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
 * Detect the placement grid pitch (in tiles) for foundation-style tiles by
 * finding the most common non-zero spacing between adjacent floor tiles along
 * each axis. V Rising stone foundations tile on a 10 m grid while their
 * collider AABB is only 6 m, so this recovers the cell size needed to render
 * floors as a continuous surface.
 *
 * Returns null when there aren't enough floor tiles to establish a grid (e.g.
 * a tiny build or one with no floors) — callers fall back to the collider
 * footprint in that case.
 *
 * @param {Array} entities
 * @param {ReturnType<typeof buildCategoryLookup>} lookup
 * @returns {number | null}
 */
export function detectGridPitch(entities, lookup) {
  // Bucket floor-tile X positions by Z row and Z positions by X column, so we
  // measure spacing between same-row / same-column neighbours.
  const byZ = new Map();
  const byX = new Map();
  for (const e of entities ?? []) {
    if (!e.tilePos) continue;
    if (!FULL_CELL_CATEGORIES.has(lookup.lookup(e.prefab).id)) continue;
    const [x, z] = e.tilePos;
    if (!byZ.has(z)) byZ.set(z, []);
    if (!byX.has(x)) byX.set(x, []);
    byZ.get(z).push(x);
    byX.get(x).push(z);
  }

  const tally = new Map();
  const addDiffs = (groups) => {
    for (const arr of groups.values()) {
      arr.sort((a, b) => a - b);
      for (let i = 1; i < arr.length; i++) {
        const d = Math.round((arr[i] - arr[i - 1]) * 1000) / 1000;
        if (d > 0) tally.set(d, (tally.get(d) ?? 0) + 1);
      }
    }
  };
  addDiffs(byZ);
  addDiffs(byX);
  if (tally.size === 0) return null;

  // Modal spacing wins. Ties break toward the smaller pitch so we never
  // over-inflate past the true cell.
  let best = null;
  let bestN = -1;
  for (const [d, n] of tally) {
    if (n > bestN || (n === bestN && best !== null && d < best)) {
      best = d;
      bestN = n;
    }
  }
  return best;
}

/**
 * Walk the entities once and produce the per-layer rect buckets for one
 * panel.
 *
 * `yFilter` is null for the merged view, or {mode, y0, y1} to keep only
 * entities matching the band:
 *
 *   - mode: 'center' (default) — entity belongs to [y0, y1) if its center Y
 *     satisfies y0 ≤ centerY < y1. Closed-open band semantics. Each entity
 *     lands in exactly one band — the right behavior for static per-floor
 *     panels. This is the historical SVG renderer's mode; passing a yFilter
 *     without an explicit mode preserves identical output.
 *
 *   - mode: 'overlap' — entity belongs to the band if its vertical extent
 *     [pos.y + y0, pos.y + y1] overlaps [y0, y1] with strict inequality.
 *     Lets a continuous draggable slider keep an entity visible across band
 *     boundaries instead of popping it in/out as the slider crosses its
 *     center. Intended for the Canvas viewer's Y-slider; unused by the SVG
 *     renderer.
 *
 * @param {Array} entities
 * @param {ReturnType<typeof buildCategoryLookup>} lookup
 * @param {{ minTX: number, maxTZ: number, cell: number }} geom
 * @param {null | { mode?: 'center' | 'overlap', y0: number, y1: number }} yFilter
 * @returns {{
 *   layers: Map<string, Map<string, { sx: number, sy: number, w: number, d: number }>>,
 *   counts: Map<string, number>,
 *   placed: number,
 *   unknown: number,
 *   unknownSample: Set<string>,
 *   skippedNoTile: number,
 *   skippedByBand: number
 * }}
 */
export function buildPanel(entities, lookup, geom, yFilter) {
  const layers = new Map();
  for (const id of LAYER_ORDER) layers.set(id, new Map());
  const counts = new Map();
  const unknownSample = new Set();
  let placed = 0;
  let unknown = 0;
  let skippedNoTile = 0;
  let skippedByBand = 0;

  const filterMode = yFilter ? (yFilter.mode ?? 'center') : null;

  for (const e of entities ?? []) {
    if (!e.tilePos) { skippedNoTile++; continue; }
    const cls = lookup.lookup(e.prefab);
    if (!cls.known) {
      unknown++;
      if (unknownSample.size < 16) unknownSample.add(e.prefab);
    }

    // Y-band filtering.
    //
    // 'center' mode (the SVG renderer's mode): closed-open band semantics on
    // the entity's center Y. Why center rather than overlap:
    //   - A floor tile (y1 - y0 ~= 0.02 m) sitting at pos.y = 10 has its
    //     center at 10.01, which lands cleanly in band [10, 15). An overlap
    //     test would either drop it (epsilon too strict) or double-count it
    //     into [5, 10) (epsilon too loose).
    //   - A wall (5 m tall) at pos.y = 10 has its center at 12.5, which
    //     lands in [10, 15) — its own floor, not the one below.
    //   - Stair pieces split into Lower/Upper variants in the game data; each
    //     flight's center sits in its own floor band, so transitions read
    //     naturally without artificial double-rendering.
    //
    // 'overlap' mode: keep the entity if its vertical extent crosses the
    // band. Right for a continuous slider — entities don't pop in/out at
    // their centers as the slider moves.
    if (filterMode) {
      const py = e.pos?.[1] ?? 0;
      if (filterMode === 'center') {
        const centerY = py + (cls.y0 + cls.y1) / 2;
        if (centerY < yFilter.y0 || centerY >= yFilter.y1) { skippedByBand++; continue; }
      } else {
        // 'overlap': [py + cls.y0, py + cls.y1] overlaps [yFilter.y0, yFilter.y1]
        const eMin = py + cls.y0;
        const eMax = py + cls.y1;
        if (eMax <= yFilter.y0 || eMin >= yFilter.y1) { skippedByBand++; continue; }
      }
    }

    const layerId = layers.has(cls.id) ? cls.id : UNKNOWN_CATEGORY;
    const bucket = layers.get(layerId);

    let w = cls.w;
    let d = cls.d;
    if (geom.pitch && FULL_CELL_CATEGORIES.has(cls.id)) {
      // Foundation-style tile: render at the placement grid cell so floors
      // form a continuous surface. Square cell, so rotation is a no-op. Never
      // shrink below the collider footprint if the detected pitch is small.
      w = Math.max(geom.pitch, cls.w);
      d = Math.max(geom.pitch, cls.d);
    } else if (swapsWidthDepth(e.rot)) {
      [w, d] = [d, w];
    }

    const sx = (e.tilePos[0] - w / 2 - geom.minTX) * geom.cell;
    const sy = (geom.maxTZ - e.tilePos[1] - d / 2) * geom.cell;
    const key = `${sx},${sy},${w},${d}`;
    bucket.set(key, { sx, sy, w, d });

    placed++;
    counts.set(cls.id, (counts.get(cls.id) ?? 0) + 1);
  }

  return { layers, counts, placed, unknown, unknownSample, skippedNoTile, skippedByBand };
}
