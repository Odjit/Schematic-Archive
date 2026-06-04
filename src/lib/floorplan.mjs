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
// floor foundation has a 6 m collider but tiles on a 10 m grid; stair pieces
// the same). Rendering the collider leaves 4 m gaps on every side, so a floor
// or a stair run reads as scattered squares instead of a continuous surface.
// For these categories we render at the detected grid pitch instead (see
// detectGridPitch + buildPanel). Stairs additionally get a direction arrow
// drawn over the run (see detectStairRuns).
//
// Deliberately NOT including 'roof': filling roof blockers to the cell would
// lay a solid sheet over the lower floors in the top-down merged view,
// obscuring the very plan we're trying to show.
export const FULL_CELL_CATEGORIES = new Set(['floor', 'stairs']);

// Category used to detect the grid pitch. Floors are the densest, most
// regular tiling, so they give the cleanest modal spacing — including stairs
// here would pollute it with their sparser, irregular runs.
const PITCH_DETECT_CATEGORY = 'floor';

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
        // Stairs carry kind (Start/Part/End/…) and dir (North/…); used by
        // detectStairRuns to orient the up/down arrow. Absent for everything
        // else.
        kind: entry?.kind,
        dir:  entry?.dir,
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
    // Lowest band is "Ground"; everything above is numbered. We deliberately
    // do NOT nickname the top band "Roof" — the band is just a height slice,
    // and "Roof" collided with the roof *category* in the legend, which is a
    // different thing (actual roof prefab pieces).
    const label = i === 0 ? 'Ground' : `Floor ${i + 1}`;
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
    if (lookup.lookup(e.prefab).id !== PITCH_DETECT_CATEGORY) continue;
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
 * Group stair pieces into runs (flights) and trace each flight's path from
 * bottom to top, so the viewer can draw a stair symbol that follows the run
 * (bending correctly on L-shaped / switchback flights) with an up-arrow.
 *
 * A V Rising staircase is many prefab pieces — Lower/Upper halves plus
 * Start / Part / End segments — that all share the same Y tags, so direction
 * can't come from pos.y. It comes from the `kind` field instead: Start is the
 * bottom of the flight, End is the top. We cluster pieces on orthogonally
 * adjacent grid cells, then BFS the shortest cell path from a Start cell to an
 * End cell. Following the cell path (rather than a straight Start→End line)
 * keeps the arrow on the stairs for L-shaped flights.
 *
 * Coordinates are returned in *tile space* (the same space buildPanel works
 * in) so any renderer can map them to its own pixels; `path` entries are cell
 * centers (= tilePos), ordered bottom→top. A run with no identifiable
 * direction gets `path === null` and should be drawn without an arrow.
 *
 * @param {Array} entities
 * @param {ReturnType<typeof buildCategoryLookup>} lookup
 * @param {number | null} pitch  grid pitch from detectGridPitch (cell spacing)
 * @returns {Array<{
 *   cells: Array<{ x: number, z: number }>,
 *   path:  Array<{ x: number, z: number }> | null,
 * }>}
 */
export function detectStairRuns(entities, lookup, pitch) {
  const step = pitch && pitch > 0 ? pitch : FLOOR_HEIGHT_M * 2; // 10 fallback
  // Collapse pieces to unique cells, tallying Start/End kinds per cell.
  const cells = new Map();
  for (const e of entities ?? []) {
    if (!e.tilePos) continue;
    const cls = lookup.lookup(e.prefab);
    if (cls.id !== 'stairs') continue;
    const [x, z] = e.tilePos;
    const key = `${x},${z}`;
    let c = cells.get(key);
    if (!c) { c = { x, z, starts: 0, ends: 0, minY: Infinity }; cells.set(key, c); }
    const kind = cls.kind ?? '';
    if (kind.includes('Start')) c.starts++;
    else if (kind.includes('End')) c.ends++;
    c.minY = Math.min(c.minY, e.pos?.[1] ?? 0);
  }
  if (cells.size === 0) return [];

  const all = [...cells.values()];
  const keyOf = (c) => `${c.x},${c.z}`;

  // Orthogonal adjacency: one step along a row or column, within ~1 grid
  // pitch, with a little slack on the perpendicular axis for imperfect
  // alignment. Orthogonal (not diagonal) so the traced path turns squarely
  // through L-shaped flights instead of cutting the corner.
  const along = step * 1.4;
  const perp  = step * 0.5;
  const adjacent = (a, b) => {
    const dx = Math.abs(a.x - b.x);
    const dz = Math.abs(a.z - b.z);
    if (dx > 0 && dx <= along && dz <= perp) return true;
    if (dz > 0 && dz <= along && dx <= perp) return true;
    return false;
  };

  const centroid = (arr) => ({
    x: arr.reduce((s, c) => s + c.x, 0) / arr.length,
    z: arr.reduce((s, c) => s + c.z, 0) / arr.length,
  });

  // Flood the orthogonal graph into clusters (one per flight).
  const seen = new Set();
  const runs = [];
  for (const seed of all) {
    if (seen.has(keyOf(seed))) continue;
    const stack = [seed];
    seen.add(keyOf(seed));
    const group = [];
    while (stack.length) {
      const cur = stack.pop();
      group.push(cur);
      for (const nb of all) {
        if (seen.has(keyOf(nb))) continue;
        if (adjacent(cur, nb)) { seen.add(keyOf(nb)); stack.push(nb); }
      }
    }

    // Build a centerline path bottom→top from the Start/End centroids. Using
    // centroids (not individual cells) keeps the line down the *middle* of a
    // wide flight so the arrow sits on the run, not off in one lane. A bend is
    // inserted only when a cell sits well off the straight Start→End line —
    // i.e. a genuine L / switchback — so straight flights stay straight.
    const starts = group.filter(c => c.starts > 0);
    const ends   = group.filter(c => c.ends > 0);
    let path = null;
    if (starts.length && ends.length) {
      const sc = centroid(starts);
      const ec = centroid(ends);
      const vx = ec.x - sc.x;
      const vz = ec.z - sc.z;
      const vlen = Math.hypot(vx, vz) || 1;
      // Farthest cell from the straight Start→End line = the elbow candidate.
      let corner = null;
      let maxPerp = 0;
      for (const c of group) {
        const cross = Math.abs((c.x - sc.x) * vz - (c.z - sc.z) * vx) / vlen;
        if (cross > maxPerp) { maxPerp = cross; corner = c; }
      }
      if (corner && maxPerp > step * 0.65) {
        // Snap the bend to a grid-axis intersection of the endpoints so both
        // segments are axis-aligned — a clean right angle, not the acute angle
        // you get bending a fractional centroid toward an integer cell. Two
        // candidates; pick the one on the side the flight actually turns
        // (nearest the elbow cell).
        const c1 = { x: sc.x, z: ec.z };
        const c2 = { x: ec.x, z: sc.z };
        const d1 = (c1.x - corner.x) ** 2 + (c1.z - corner.z) ** 2;
        const d2 = (c2.x - corner.x) ** 2 + (c2.z - corner.z) ** 2;
        path = [sc, d1 <= d2 ? c1 : c2, ec];
      } else {
        path = [sc, ec];
      }
    }

    // Lowest piece Y in the flight — used to assign the whole run to the floor
    // it rises from, so a vertical staircase isn't sliced across floor bands.
    const minY = Math.min(...group.map(c => c.minY));

    runs.push({
      cells: group.map(c => ({ x: c.x, z: c.z })),
      path,
      minY: Number.isFinite(minY) ? minY : 0,
    });
  }
  return runs;
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
 * @param {{ stairCells?: Set<string> }} [opts]
 *   stairCells: when set, stair-category pieces are kept iff their
 *   "tileX,tileZ" key is in the set, bypassing yFilter. Lets the caller show a
 *   whole staircase on the floor it rises from instead of slicing the vertical
 *   flight across height bands (stairs are connectors, not single-floor
 *   pieces). Omit to filter stairs like everything else.
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
export function buildPanel(entities, lookup, geom, yFilter, opts = {}) {
  const layers = new Map();
  for (const id of LAYER_ORDER) layers.set(id, new Map());
  const counts = new Map();
  const unknownSample = new Set();
  let placed = 0;
  let unknown = 0;
  let skippedNoTile = 0;
  let skippedByBand = 0;

  const filterMode = yFilter ? (yFilter.mode ?? 'center') : null;
  const stairCells = opts.stairCells ?? null;
  // Per-entity hit rects for hover tooltips (not deduped — keeps prefab names).
  const hits = opts.collectHits ? [] : null;

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
    //
    // Stairs are special: when the caller supplies stairCells, a vertical
    // flight is shown whole on the floor it rises from (its run's cells),
    // bypassing the per-piece height slice that would otherwise cut the
    // staircase in half across two floor bands.
    if (cls.id === 'stairs' && stairCells) {
      if (!stairCells.has(`${e.tilePos[0]},${e.tilePos[1]}`)) { skippedByBand++; continue; }
    } else if (filterMode) {
      const py = e.pos?.[1] ?? 0;
      if (filterMode === 'center') {
        const centerY = py + (cls.y0 + cls.y1) / 2;
        if (centerY < yFilter.y0 || centerY >= yFilter.y1) { skippedByBand++; continue; }
      } else {
        // 'overlap': keep the entity if its vertical extent meets the band.
        //
        // Two regimes, because floors are infinitely thin and walls are not:
        //
        //   - Tall pieces (walls, stairs, …) use a half-open overlap:
        //     (eMin, eMax) must intersect [y0, y1]. A wall ending exactly at
        //     the band floor — extent [5, 10] against band [10, 15] — belongs
        //     to the floor *below* and is correctly excluded, while a wall
        //     spanning [10, 15] is kept.
        //
        //   - Zero-height pieces (floor tiles: cls.y0 == cls.y1) use an
        //     inclusive plane-in-band test with SLICE_EDGE_EPS slack, so the
        //     floor tile at y=10 still appears in a slice starting at 10.
        //     Without this the slider would show walls hovering over no floor.
        //     Because the slider window is one FLOOR_HEIGHT_M tall, every
        //     window contains at least one floor plane, so a floor surface is
        //     always visible as you drag.
        const eMin = py + cls.y0;
        const eMax = py + cls.y1;
        const isThin = (eMax - eMin) <= SLICE_EDGE_EPS;
        const inBand = isThin
          ? (eMin >= yFilter.y0 - SLICE_EDGE_EPS && eMin <= yFilter.y1 + SLICE_EDGE_EPS)
          : (eMax > yFilter.y0 && eMin < yFilter.y1);
        if (!inBand) { skippedByBand++; continue; }
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
    if (hits) {
      hits.push({ x: sx, y: sy, w: w * geom.cell, h: d * geom.cell, prefab: e.prefab, layerId });
    }

    placed++;
    counts.set(cls.id, (counts.get(cls.id) ?? 0) + 1);
  }

  return { layers, counts, placed, unknown, unknownSample, skippedNoTile, skippedByBand, hits };
}
