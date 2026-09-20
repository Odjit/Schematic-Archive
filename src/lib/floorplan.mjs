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
  'pavement',
  'carpet',
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
  'servant',
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

// Flat surface overlays (pavement paths, carpets) whose collider is smaller
// than the placement cell. Rendered as "ribbons": each piece keeps its thin
// collider footprint, but the gap to an adjacent same-category piece is
// bridged so a path/rug reads as a connected strip that's visibly thinner
// than a full floor tile. See buildPanel.
export const RIBBON_CATEGORIES = new Set(['pavement', 'carpet']);

// Path-piece arm directions (tile-space [dx, dz]) for each junction shape, in
// the unrotated frame. Derived empirically from V Rising pavement/carpet
// placements: a Straight runs N–S, a Corner joins +Z & −X, a T omits −Z, a
// Cross has all four. Rotation maps (dx, dz) -> (dz, -dx) per +90° (also
// derived from the data). Reading arms from the piece TYPE (not neighbour
// positions) avoids T-junctions rendering as crosses when paths jog a tile.
const SHAPE_ARMS = {
  straight: [[0, 1], [0, -1]],
  corner:   [[0, 1], [-1, 0]],
  tee:      [[1, 0], [-1, 0], [0, 1]],
  cross:    [[1, 0], [-1, 0], [0, 1], [0, -1]],
};

/** Classify a pavement/carpet prefab name into a junction shape. */
export function ribbonShape(prefabName) {
  if (/Cross[_-]?Section/i.test(prefabName)) return 'cross';
  if (/T[_-]?Section/i.test(prefabName))     return 'tee';
  if (/Corner/i.test(prefabName))            return 'corner';
  if (/Straight/i.test(prefabName))          return 'straight';
  return 'cross'; // plain/unknown surface tile: allow connecting on any side
}

/** World-space arm directions ([dx, dz]) for a shape at a Y rotation (deg). */
export function ribbonArms(shape, rotYDeg = 0) {
  const base = SHAPE_ARMS[shape] ?? SHAPE_ARMS.cross;
  const steps = ((Math.round((rotYDeg || 0) / 90) % 4) + 4) % 4;
  return base.map(([dx, dz]) => {
    for (let i = 0; i < steps; i++) { [dx, dz] = [dz, -dx]; }
    // Normalize -0 -> 0 (from negating a zero) for clean, comparable output.
    return [dx === 0 ? 0 : dx, dz === 0 ? 0 : dz];
  });
}

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

// Doors carry a chunky ~4×4 clearance collider, which renders as a fat square
// straddling the wall. We instead draw them as a slim bar — full length along
// the wall, this thin across — so a doorway reads as an opening in the wall
// line rather than a block. In tile units, and a shade thicker than the 2-tile
// (1 m) wall it sits in so the door colour stays legible on top of it.
export const DOOR_THICKNESS = 3;

// Tile units per world metre.
//
// `tilePos` is NOT in metres: across the sample builds, one tilePos step is
// exactly 0.5 m of world position (verified over 2048 entity pairs), and the
// detected placement pitch of 10 tiles matches the 5 m castle cell. The prefab
// table's `w`/`d`, by contrast, come straight off the collider AABB in metres
// (see deriveFootprint in scripts/build-render-prefabs.mjs) — a 5 m wall is
// w:5, which is 10 tiles long.
//
// Both renderers convert with this constant, but over different sets:
//   - the isometric view applies it to everything (it's a massing model, so a
//     piece's true volume is the point)
//   - buildPanel applies it to STRUCTURE_CATEGORIES only (see below)
export const TILES_PER_METRE = 2;

// Categories drawn at their true size in the plan.
//
// These are the pieces that tile edge to edge, so half scale showed up as a
// defect rather than a style: a 5 m wall drawn 5 tiles long on a 10-tile pitch
// left a gap after every segment, turning a wall run into a dashed line, and
// the 1 m pillars at the joints bulged outside it instead of closing them.
//
// Everything else keeps the table's metre figures as a compact symbol.
// Workstations, storage and coffins carry clearance colliders rather than
// visual footprints, and they paint after the walls (see LAYER_ORDER), so
// drawing them at true size buries the structure they sit against. Pavement
// and carpet stay thin on purpose too: a ribbon should read as the path it is
// in game, not as a filled cell.
export const STRUCTURE_CATEGORIES = new Set(['wall', 'fence', 'door']);

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
 * @param {object} schematic parsed .schematic JSON
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
      let id = entry?.category;
      let known = !!entry;
      let fw;
      let fd;
      if (!entry) {
        // Name-pattern fallback for entities the structural prefab dump
        // doesn't carry (no PhysicsCollider AABB) — e.g. placed NPCs. Without
        // this they'd read as generic "unknown" 1×1 markers.
        const fb = NAME_FALLBACKS.find(f => f.test.test(prefabName));
        if (fb) { id = fb.id; known = true; fw = fb.w; fd = fb.d; }
      }
      id = id ?? UNKNOWN_CATEGORY;
      const meta = byCategory.get(id) ?? byCategory.get(UNKNOWN_CATEGORY);
      return {
        id,
        color: meta.color,
        label: meta.label,
        w:  entry?.w  ?? fw ?? FALLBACK_W,
        d:  entry?.d  ?? fd ?? FALLBACK_D,
        y0: entry?.y0 ?? FALLBACK_Y0,
        y1: entry?.y1 ?? FALLBACK_Y1,
        // Stairs carry kind (Start/Part/End/…) and dir (North/…); used by
        // detectStairRuns to orient the up/down arrow. Absent for everything
        // else.
        kind: entry?.kind,
        dir:  entry?.dir,
        // Pavement/carpet junction shape (straight/corner/tee/cross), from the
        // prefab name — drives shape-aware ribbon arms in buildPanel.
        shape: RIBBON_CATEGORIES.has(id) ? ribbonShape(prefabName) : undefined,
        known,
      };
    },
    categories: prefabTable.categories,
  };
}

// Name-pattern classification for entities absent from the structural dump.
// Ordered; first match wins. Footprint is a small marker since these have no
// collider AABB to size from.
const NAME_FALLBACKS = [
  { test: /^CHAR_/, id: 'servant', w: 2, d: 2 },
];

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
 * @param {object} schematic parsed .schematic JSON
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
/**
 * Build the "does this entity belong in the current view?" predicate shared by
 * the plan and isometric renderers.
 *
 * Y-band filtering:
 *
 * 'center' mode (the SVG renderer's mode): closed-open band semantics on the
 * entity's center Y. Why center rather than overlap:
 *   - A floor tile (y1 - y0 ~= 0.02 m) sitting at pos.y = 10 has its center at
 *     10.01, which lands cleanly in band [10, 15). An overlap test would either
 *     drop it (epsilon too strict) or double-count it into [5, 10) (epsilon too
 *     loose).
 *   - A wall (5 m tall) at pos.y = 10 has its center at 12.5, which lands in
 *     [10, 15) — its own floor, not the one below.
 *   - Stair pieces split into Lower/Upper variants in the game data; each
 *     flight's center sits in its own floor band, so transitions read naturally
 *     without artificial double-rendering.
 *
 * 'overlap' mode: keep the entity if its vertical extent crosses the band.
 * Right for a continuous slider — entities don't pop in/out at their centers as
 * the slider moves.
 *
 * `stairCells` bypasses the band for stairs, so a whole staircase shows on the
 * floor it rises from instead of being sliced in half.
 *
 * @param {object|null} yFilter
 * @param {Set<string>|null} stairCells
 * @returns {(entity: object, cls: object) => boolean}
 */
export function makeEntityFilter(yFilter, stairCells = null) {
  const filterMode = yFilter ? (yFilter.mode ?? 'center') : null;
  return (e, cls) => {
    if (cls.id === 'stairs' && stairCells) {
      return stairCells.has(`${e.tilePos[0]},${e.tilePos[1]}`);
    }
    if (!filterMode) return true;
    const py = e.pos?.[1] ?? 0;
    if (filterMode === 'center') {
      const centerY = py + (cls.y0 + cls.y1) / 2;
      return centerY >= yFilter.y0 && centerY < yFilter.y1;
    }
    const eMin = py + cls.y0;
    const eMax = py + cls.y1;
    const isThin = (eMax - eMin) <= SLICE_EDGE_EPS;
    return isThin
      ? (eMin >= yFilter.y0 - SLICE_EDGE_EPS && eMin <= yFilter.y1 + SLICE_EDGE_EPS)
      : (eMax > yFilter.y0 && eMin < yFilter.y1);
  };
}

/**
 * Build the pavement/carpet ribbons for a view, in TILE space.
 *
 * Shared by the plan and the isometric view so a path has one shape in both.
 * Returns rects as {x0, z0, w, d} with x0/z0 the minimum corner in tile
 * coordinates; callers map that into their own projection.
 *
 * Two passes, because the raw tilePos data is noisy — pieces on a straight
 * path jitter ±1 tile in spacing and step ±1 sideways:
 *
 *  1. SNAP each piece to a clean grid (the category's dominant phase), so
 *     paths become uniform straight lines, neighbours sit exactly one pitch
 *     apart, and junctions line up. `occ` records the snapped occupancy.
 *  2. Emit the piece at its snapped position, then bridge each of its
 *     intrinsic arms — read from the junction shape (straight/corner/tee/
 *     cross) + rotation, NOT from neighbour positions — to the nearest
 *     occupied neighbour 1–2 cells away in that direction.
 *
 * Reading arms from the piece TYPE stops a T rendering as a cross (a parallel
 * path can't add a phantom 4th arm). Allowing a 2-cell reach connects across a
 * doorway or bare wall opening; the bridge paints under walls, so it's hidden
 * except at the opening.
 *
 * Ribbons keep the prefab table's raw w/d — half a cell — rather than filling
 * their cell. A path in game is a walkway across the tile, not the whole tile,
 * and the bridges are what make it read as a connected route.
 *
 * @param {Array} entities
 * @param {ReturnType<typeof buildCategoryLookup>} lookup
 * @param {number} pitch placement grid pitch in tiles (0/null disables)
 * @param {(e: object, cls: object) => boolean} passes visibility predicate
 * @returns {{ rects: Array<{x0:number,z0:number,w:number,d:number,layerId:string,prefab:string}>,
 *             counts: Map<string, number>, placed: number }}
 */
export function buildRibbonRects(entities, lookup, pitch, passes) {
  const rects = [];
  const seen = new Set();
  const counts = new Map();
  let placed = 0;
  if (!pitch) return { rects, counts, placed };

  const snapTile = (v, phase) =>
    Math.round((v - phase) / pitch) * pitch + phase;

  // Pass 1: per-category dominant phase + snapped occupancy.
  const rawByCat = new Map();
  for (const e of entities ?? []) {
    if (!e.tilePos) continue;
    const cls = lookup.lookup(e.prefab);
    if (!RIBBON_CATEGORIES.has(cls.id) || !passes(e, cls)) continue;
    let list = rawByCat.get(cls.id);
    if (!list) { list = []; rawByCat.set(cls.id, list); }
    list.push(e.tilePos);
  }
  const phases = new Map();
  const occ = new Map();
  for (const [cat, list] of rawByCat) {
    const phx = modalPhase(list.map(t => t[0]), pitch);
    const phz = modalPhase(list.map(t => t[1]), pitch);
    phases.set(cat, [phx, phz]);
    const set = new Set();
    for (const t of list) set.add(`${snapTile(t[0], phx)},${snapTile(t[1], phz)}`);
    occ.set(cat, set);
  }

  // Pass 2: base tile + arm bridges.
  for (const e of entities ?? []) {
    if (!e.tilePos) continue;
    const cls = lookup.lookup(e.prefab);
    if (!RIBBON_CATEGORIES.has(cls.id) || !passes(e, cls)) continue;

    const cells = occ.get(cls.id);
    const [phx, phz] = phases.get(cls.id) ?? [0, 0];
    const tx = snapTile(e.tilePos[0], phx);
    const tz = snapTile(e.tilePos[1], phz);
    const rw = cls.w;
    const rd = cls.d;
    // Carry the piece's world Y so a 3D caller can lay the ribbon on its floor.
    const y = (e.pos?.[1] ?? 0) + cls.y0;
    // Two neighbours bridge toward each other and produce the same rect, so
    // emit each one once. (The plan used to absorb this in its own rect map;
    // doing it here means every caller gets the same path, and the iso view
    // doesn't fill the same box twice.)
    const push = (x0, z0, w, d) => {
      const key = `${x0},${z0},${w},${d},${y},${cls.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      rects.push({ x0, z0, w, d, y, layerId: cls.id, prefab: e.prefab });
    };

    push(tx - rw / 2, tz - rd / 2, rw, rd);

    for (const [dx, dz] of ribbonArms(cls.shape, e.rot?.[1] ?? 0)) {
      let reach = 0;
      for (let k = 1; k <= 2; k++) {
        const nk = dx !== 0 ? `${tx + dx * k * pitch},${tz}` : `${tx},${tz + dz * k * pitch}`;
        if (cells && cells.has(nk)) { reach = k; break; }
      }
      if (!reach) continue;
      const len = reach * pitch;
      if (dx !== 0) {
        push(dx > 0 ? tx : tx - len, tz - rd / 2, len, rd);
      } else {
        push(tx - rw / 2, (dz > 0 ? tz + len : tz) - len, rw, len);
      }
    }

    placed++;
    counts.set(cls.id, (counts.get(cls.id) ?? 0) + 1);
  }

  return { rects, counts, placed };
}

/** Most common value of `vals` modulo `pitch`. */
function modalPhase(vals, pitch) {
  const tally = new Map();
  let best = 0;
  let bestN = -1;
  for (const v of vals) {
    const r = ((v % pitch) + pitch) % pitch;
    const n = (tally.get(r) ?? 0) + 1;
    tally.set(r, n);
    if (n > bestN) { bestN = n; best = r; }
  }
  return best;
}

/**
 * Snap structural pieces onto one wall line.
 *
 * V Rising anchors a wall on its face rather than its centre-line, so the same
 * piece flipped 180° has a pivot one tile (0.5 m) away. Drawn as-is, a wall
 * run visibly kinks sideways wherever the facing flips — in the samples,
 * horizontal walls sit at z ≡ 0 facing one way and z ≡ 9 facing the other.
 *
 * So we snap each piece's CROSS-axis coordinate (the thickness direction) to
 * the dominant phase for its orientation. Which of the two phases wins doesn't
 * matter much — either way the line is straight, and it's off by at most half
 * a metre, which is well inside what a diagram at 2-8 px per tile can show.
 *
 * The along-axis is deliberately left alone: the same flip shifts it by a tile
 * too, but that lands as a one-tile seam between segments, and the pillars that
 * sit on every joint already cover it.
 *
 * @returns {(e: object, cls: object) => [number, number]} tilePos mapper
 */
export function makeStructureSnap(entities, lookup, pitch, passes, snapCategories = STRUCTURE_CATEGORIES) {
  if (!pitch) return (e) => e.tilePos;

  // Cross axis: a piece running along X is snapped in Z, and vice versa.
  const alongZ = [];
  const alongX = [];
  for (const e of entities ?? []) {
    if (!e.tilePos) continue;
    const cls = lookup.lookup(e.prefab);
    if (!STRUCTURE_CATEGORIES.has(cls.id) || !passes(e, cls)) continue;
    (swapsWidthDepth(e.rot) ? alongX : alongZ).push(
      swapsWidthDepth(e.rot) ? e.tilePos[0] : e.tilePos[1],
    );
  }
  const phaseZ = modalPhase(alongZ, pitch);
  const phaseX = modalPhase(alongX, pitch);
  const snap = (v, phase) => Math.round((v - phase) / pitch) * pitch + phase;

  return (e, cls) => {
    if (!snapCategories.has(cls.id)) return e.tilePos;
    return swapsWidthDepth(e.rot)
      ? [snap(e.tilePos[0], phaseX), e.tilePos[1]]
      : [e.tilePos[0], snap(e.tilePos[1], phaseZ)];
  };
}

export function buildPanel(entities, lookup, geom, yFilter, opts = {}) {
  const layers = new Map();
  for (const id of LAYER_ORDER) layers.set(id, new Map());
  const counts = new Map();
  const unknownSample = new Set();
  let placed = 0;
  let unknown = 0;
  let skippedNoTile = 0;
  let skippedByBand = 0;

  const stairCells = opts.stairCells ?? null;
  // Per-entity hit rects for hover tooltips (not deduped — keeps prefab names).
  const hits = opts.collectHits ? [] : null;

  // Does an entity survive the current Y / stairCells filter? Pure (no
  // counters) so the ribbon pre-pass can reuse it without affecting stats.
  const passes = makeEntityFilter(yFilter, stairCells);

  const ribbonPitch = geom.pitch || 0;
  // Ribbons and the structural wall line are both built from shared helpers,
  // so the isometric view draws the same paths and the same straight walls.
  const ribbon = buildRibbonRects(entities, lookup, ribbonPitch, passes);
  const snapStructure = makeStructureSnap(entities, lookup, ribbonPitch, passes);

  // Emit one rect (tile-unit w/d at pixel sx/sy) into a bucket + hit list.
  const pushRect = (bucket, layerId, prefab, sx, sy, wTiles, dTiles) => {
    bucket.set(`${sx},${sy},${wTiles},${dTiles}`, { sx, sy, w: wTiles, d: dTiles });
    if (hits) hits.push({ x: sx, y: sy, w: wTiles * geom.cell, h: dTiles * geom.cell, prefab, layerId });
  };

  for (const e of entities ?? []) {
    if (!e.tilePos) { skippedNoTile++; continue; }
    const cls = lookup.lookup(e.prefab);
    if (!cls.known) {
      unknown++;
      if (unknownSample.size < 16) unknownSample.add(e.prefab);
    }

    // Y-band / stairCells filtering — see makeEntityFilter for the band
    // semantics. Pavement/carpet are flat (center ~0.5 m) so they sit on the
    // ground band like floors.
    if (!passes(e, cls)) { skippedByBand++; continue; }

    const layerId = layers.has(cls.id) ? cls.id : UNKNOWN_CATEGORY;
    const bucket = layers.get(layerId);

    // Ribbons were built up front by buildRibbonRects (they need a whole-view
    // occupancy pass before any one piece can be drawn); their rects and
    // counts are merged in below.
    if (ribbonPitch && RIBBON_CATEGORIES.has(cls.id)) continue;

    // Structure is drawn at true size, everything else at the table's metre
    // figures (see STRUCTURE_CATEGORIES for why the plan splits them).
    const structural = STRUCTURE_CATEGORIES.has(cls.id);
    let w = structural ? cls.w * TILES_PER_METRE : cls.w;
    let d = structural ? cls.d * TILES_PER_METRE : cls.d;
    if (geom.pitch && FULL_CELL_CATEGORIES.has(cls.id)) {
      // Foundation-style tile: render at the placement grid cell so floors
      // form a continuous surface. Square cell, so rotation is a no-op. Never
      // shrink below the collider footprint if the detected pitch is small.
      w = Math.max(geom.pitch, cls.w);
      d = Math.max(geom.pitch, cls.d);
    } else if (cls.id === 'door') {
      // Slim the bulky clearance collider down to a wall-thin bar, then
      // orient it along the wall via the rotation rule (as walls do).
      d = Math.min(d, DOOR_THICKNESS);
      if (swapsWidthDepth(e.rot)) { [w, d] = [d, w]; }
    } else if (swapsWidthDepth(e.rot)) {
      [w, d] = [d, w];
    }

    // Structural pieces snap onto one wall line (see makeStructureSnap);
    // everything else draws where it sits.
    const [tx, tz] = snapStructure(e, cls);
    const sx = (tx - w / 2 - geom.minTX) * geom.cell;
    const sy = (geom.maxTZ - tz - d / 2) * geom.cell;
    pushRect(bucket, layerId, e.prefab, sx, sy, w, d);

    placed++;
    counts.set(cls.id, (counts.get(cls.id) ?? 0) + 1);
  }

  // Merge in the ribbons, mapping their tile-space rects into panel pixels.
  // z0 is the minimum Z corner, and panel Y is flipped (north-up), so the top
  // edge comes from z0 + d.
  for (const r of ribbon.rects) {
    const bucket = layers.get(r.layerId) ?? layers.get(UNKNOWN_CATEGORY);
    pushRect(bucket, r.layerId, r.prefab,
      (r.x0 - geom.minTX) * geom.cell,
      (geom.maxTZ - (r.z0 + r.d)) * geom.cell,
      r.w, r.d);
  }
  for (const [id, n] of ribbon.counts) counts.set(id, (counts.get(id) ?? 0) + n);
  placed += ribbon.placed;

  return { layers, counts, placed, unknown, unknownSample, skippedNoTile, skippedByBand, hits };
}
