/**
 * isoplan.mjs — pure functions for an isometric ("dollhouse") view of a build.
 *
 * Companion to floorplan.mjs. Same inputs — entities, the category lookup, a
 * Y-band filter — but instead of flat rects it produces extruded boxes in a
 * back-to-front paint order, so a build reads as a massing model rather than a
 * color-coded plan. Nothing here emits SVG or touches the DOM; the caller
 * paints the boxes (isoplan-canvas.ts does it for the browser).
 *
 * Why a second projection rather than a 3D engine: every prefab we have is an
 * axis-aligned collider box (the prefab table carries w/d and y0/y1, no
 * meshes), so the whole scene is boxes either way. A painter's-algorithm
 * canvas pass costs no dependency, runs on the same geometry the plan uses,
 * and can also be rendered at build time by Node.
 *
 * Units — the one subtle part:
 *   - x/z, and box w/d, are TILE units (tilePos space), matching floorplan.mjs
 *   - y0/y1 are METRES, as the prefab table stores them
 *   - a tile is 0.5 m, so heights convert with TILES_PER_METRE
 * Footprints from the table are metres, so they're scaled into tile units here
 * (see TILES_PER_METRE in floorplan.mjs) — that's what makes a row of 5 m wall
 * pieces on a 10-tile pitch read as one continuous wall instead of pickets.
 */
import {
  FLOOR_HEIGHT_M,
  FULL_CELL_CATEGORIES,
  LAYER_ORDER,
  RIBBON_CATEGORIES,
  STRUCTURE_CATEGORIES,
  TILES_PER_METRE,
  UNKNOWN_CATEGORY,
  buildRibbonRects,
  detectStairRuns,
  makeEntityFilter,
  makeStructureSnap,
  swapsWidthDepth,
} from './floorplan.mjs';

/** 2:1-ish isometric: 30° above the horizon. */
export const ISO_COS = Math.cos(Math.PI / 6);
export const ISO_SIN = Math.sin(Math.PI / 6);

/** Minimum box height in metres, so flat pieces (floors, carpet) still paint. */
const MIN_BOX_H = 0.06;

/**
 * A castle wall is 1 m thick. Wall-mounted pieces are flattened to this across
 * the wall so they sit in its plane instead of standing proud of it.
 */
const WALL_THICKNESS_M = 1;

/**
 * Height a stair piece is drawn at when it can't be resolved to a flight.
 *
 * Stairs are a FULL_CELL category, so each piece covers its whole cell — at
 * collider height that's a 5 m solid block per cell, and a flight becomes a
 * wall of cubes. A piece is one section of tread, not a storey of masonry.
 * Flights that detectStairRuns can trace are drawn as a stepped ramp instead
 * (see buildStairSteps); this is the fallback for the ones it can't.
 */
const STAIR_PLATFORM_M = 1.2;

/**
 * Turn traced stair flights into stepped boxes that actually climb.
 *
 * A flight's pieces don't carry their own rise — they come in Lower and Upper
 * halves pinned to the two storey heights, so extruding them individually can
 * only ever produce two levels. The rise lives in the flight: detectStairRuns
 * gives its cells in order from bottom to top, so cell i of n rises (i+1)/n of
 * a storey, and a box from the floor up to that tread reads as a staircase.
 *
 * One box per cell of the traced path, not per piece: a cell usually holds
 * both a Lower and an Upper piece, and they're the same step.
 *
 * @param {Array} runs from detectStairRuns
 * @param {Set<string>} visibleCells stair cells that survived the view filter
 * @param {number} pitch placement grid pitch in tiles
 * @returns {{ steps: Array<object>, handled: Set<string> }}
 */
function buildStairSteps(runs, visibleCells, pitch) {
  const steps = [];
  const handled = new Set();
  if (!pitch) return { steps, handled };

  for (const run of runs) {
    const path = run.path;
    if (!path || path.length < 2) continue;              // no direction: fall back
    const cells = run.cells ?? [];
    if (!cells.some(c => visibleCells.has(`${c.x},${c.z}`))) continue; // not in view

    // The path is a simplified centreline (endpoints plus any elbow), not one
    // point per cell, so each cell is placed by how far along that line it
    // falls. Offsetting by one pitch top and bottom makes the first cell a
    // step up rather than a zero-height sliver, and the last land exactly a
    // storey up.
    const total = polylineLength(path);
    for (const cell of cells) {
      const along = distanceAlong(path, cell);
      const rise = ((along + pitch) / (total + pitch)) * FLOOR_HEIGHT_M;
      const x0 = cell.x - pitch / 2;
      const z0 = cell.z - pitch / 2;
      const h = Math.max(MIN_BOX_H, rise);
      steps.push({
        x0, z0, w: pitch, d: pitch,
        by: run.minY,
        h,
        layerId: 'stairs',
        prefab: 'stairs',
        depth: x0 + z0,
        ...isoBounds(x0, z0, pitch, pitch, run.minY, h),
      });
      handled.add(`${cell.x},${cell.z}`);
    }
  }
  return { steps, handled };
}

/** Total length of a cell-centre polyline, in tiles. */
function polylineLength(path) {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
  }
  return total;
}

/**
 * How far along `path` a cell sits, in tiles — the cell is projected onto the
 * nearest point of the line, so cells in the side lanes of a wide flight land
 * at the same height as the one beside them on the centreline.
 */
function distanceAlong(path, cell) {
  let bestDist = Infinity;
  let bestAlong = 0;
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const segLen = Math.hypot(dx, dz);
    if (segLen === 0) continue;
    const t = Math.max(0, Math.min(1,
      ((cell.x - a.x) * dx + (cell.z - a.z) * dz) / (segLen * segLen)));
    const dist = Math.hypot(cell.x - (a.x + dx * t), cell.z - (a.z + dz * t));
    if (dist < bestDist) {
      bestDist = dist;
      bestAlong = acc + t * segLen;
    }
    acc += segLen;
  }
  return bestAlong;
}

/**
 * Pieces that live on a wall and should share its line. Wall decor is here
 * because most of it is windows: `TM_Castle_WallDecor_Gothic_Window01_*` and
 * friends carry a 3x2 m collider, which extruded on its own pivot bolts a slab
 * onto both faces of a 1 m wall. Snapped and flattened, the same box lands
 * inside the wall volume and reads as a panel set into it.
 */
const SNAP_TO_WALL_LINE = new Set([...STRUCTURE_CATEGORIES, 'wall-decor']);

// Paint order within one (depth, height) tie — mirrors the plan's z-stacking
// so a carpet lands on its floor tile, not under it.
const LAYER_RANK = new Map(LAYER_ORDER.map((id, i) => [id, i]));

/**
 * Project a point from tile/metre space to iso screen space, in tile-sized
 * units (the caller multiplies by its pixel cell size).
 *
 * @param {number} tx tile X
 * @param {number} tz tile Z
 * @param {number} yM world Y in metres
 * @returns {[number, number]} [screenX, screenY] in tile units
 */
export function isoProject(tx, tz, yM) {
  return [
    (tx - tz) * ISO_COS,
    (tx + tz) * ISO_SIN - yM * TILES_PER_METRE,
  ];
}

/**
 * Projected bounding box of one extruded box's silhouette, in the tile-sized
 * units isoProject returns.
 *
 * The extremes are corners, so they're analytic rather than a loop:
 *   - left edge  = the (x0, z1) corner, right edge = (x1, z0)
 *   - top edge   = the far corner at the box's top
 *   - bottom     = the near corner at its base
 *
 * @returns {{ u0: number, u1: number, v0: number, v1: number }}
 */
function isoBounds(x0, z0, w, d, by, h) {
  const x1 = x0 + w;
  const z1 = z0 + d;
  return {
    u0: (x0 - z1) * ISO_COS,
    u1: (x1 - z0) * ISO_COS,
    v0: (x0 + z0) * ISO_SIN - (by + h) * TILES_PER_METRE,
    v1: (x1 + z1) * ISO_SIN - by * TILES_PER_METRE,
  };
}

/**
 * Bucket entities into extruded boxes, sorted back to front.
 *
 * Takes the same (entities, lookup, geom, yFilter, opts) contract as
 * buildPanel, so a caller can swap renderers without re-deriving anything.
 *
 * @param {Array} entities
 * @param {ReturnType<typeof import('./floorplan.mjs').buildCategoryLookup>} lookup
 * @param {{ pitch?: number|null }} geom  grid pitch, for full-cell sizing
 * @param {object|null} yFilter
 * @param {{ stairCells?: Set<string>, wallHeightScale?: number }} [opts]
 * @returns {{
 *   boxes: Array<{ x0: number, z0: number, w: number, d: number,
 *                  by: number, h: number, layerId: string, prefab: string }>,
 *   counts: Map<string, number>,
 *   placed: number,
 *   yMin: number,
 * }}
 */
export function buildIsoScene(entities, lookup, geom, yFilter, opts = {}) {
  const passes = makeEntityFilter(yFilter, opts.stairCells ?? null);
  const pitch = geom.pitch || 0;
  // Walls at true height hide the interior behind them. Scaling them down
  // gives the cutaway "dollhouse" read: you see over the near walls into the
  // rooms, and the wall lines still describe the layout. 1 = true height.
  const wallScale = opts.wallHeightScale ?? 1;

  const boxes = [];
  const counts = new Map();
  let placed = 0;
  let yMin = Infinity;

  // Paths are built by the shared ribbon pass, exactly as the plan builds
  // them: snapped, bridged, and half a cell wide rather than filling the tile,
  // because that's how a walkway reads in game.
  const ribbon = buildRibbonRects(entities, lookup, pitch, passes);
  // Same wall-line snap the plan uses, so a wall doesn't kink where a piece is
  // flipped (see makeStructureSnap). Wall decor joins the snap here: it's
  // mounted on a wall, so it belongs on the wall's line, not on its own pivot.
  const snapStructure = makeStructureSnap(
    entities, lookup, pitch, passes, SNAP_TO_WALL_LINE,
  );

  // Stair flights are drawn as one stepped ramp per traced run rather than
  // per piece (see buildStairSteps). Cells a run covers are recorded so the
  // pieces standing on them don't get drawn a second time.
  const visibleStairCells = new Set();
  for (const e of entities ?? []) {
    if (!e.tilePos) continue;
    const cls = lookup.lookup(e.prefab);
    if (cls.id === 'stairs' && passes(e, cls)) {
      visibleStairCells.add(`${e.tilePos[0]},${e.tilePos[1]}`);
    }
  }
  const stairs = buildStairSteps(
    detectStairRuns(entities, lookup, pitch), visibleStairCells, pitch,
  );
  for (const step of stairs.steps) {
    boxes.push(step);
    if (step.by < yMin) yMin = step.by;
  }
  for (const r of ribbon.rects) {
    boxes.push({
      x0: r.x0, z0: r.z0, w: r.w, d: r.d,
      by: r.y,
      // A path lies ON the floor tiles it crosses and is coplanar with them,
      // so depth between the two is meaningless. Sorted on its own far corner
      // a path sank under the floor of every cell it entered, which broke each
      // route into disconnected patches. Its NEAR corner puts it after the
      // floor of every cell it touches, including the far one a bridge reaches
      // into.
      depth: (r.x0 + r.w) + (r.z0 + r.d),
      h: MIN_BOX_H,
      layerId: r.layerId,
      prefab: r.prefab,
      ...isoBounds(r.x0, r.z0, r.w, r.d, r.y, MIN_BOX_H),
    });
    if (r.y < yMin) yMin = r.y;
  }
  for (const [id, n] of ribbon.counts) counts.set(id, (counts.get(id) ?? 0) + n);
  // placed counts PIECES, not rects: one path piece can emit a base tile plus
  // up to four bridges.
  placed += ribbon.placed;

  for (const e of entities ?? []) {
    if (!e.tilePos) continue;
    const cls = lookup.lookup(e.prefab);
    if (!passes(e, cls)) continue;
    if (pitch && RIBBON_CATEGORIES.has(cls.id)) continue; // handled above

    const layerId = LAYER_RANK.has(cls.id) ? cls.id : UNKNOWN_CATEGORY;

    // A stair piece on a cell the ramp already covers is that ramp; count it
    // for the legend, but don't stack a second box on the step.
    if (cls.id === 'stairs' && stairs.handled.has(`${e.tilePos[0]},${e.tilePos[1]}`)) {
      counts.set(layerId, (counts.get(layerId) ?? 0) + 1);
      placed++;
      continue;
    }

    // Footprint in tile units. Floors and stairs snap to the placement cell
    // so surfaces are continuous; everything else takes its true collider
    // size, which for a 5 m wall is a full 10-tile span.
    let w = cls.w * TILES_PER_METRE;
    let d = cls.d * TILES_PER_METRE;
    if (swapsWidthDepth(e.rot)) { [w, d] = [d, w]; }
    if (pitch && FULL_CELL_CATEGORIES.has(cls.id)) {
      w = pitch;
      d = pitch;
    } else if (cls.id === 'wall-decor') {
      // Flatten across the wall so the piece sits in its plane (see
      // SNAP_TO_WALL_LINE). The cross axis is the one the piece isn't running
      // along, which its rotation already tells us.
      const thick = WALL_THICKNESS_M * TILES_PER_METRE;
      if (swapsWidthDepth(e.rot)) w = Math.min(w, thick);
      else d = Math.min(d, thick);
    }

    let baseY = (e.pos?.[1] ?? 0) + cls.y0;
    let h = Math.max(MIN_BOX_H, cls.y1 - cls.y0);
    if (RIBBON_CATEGORIES.has(cls.id)) {
      // Only reached when there's no pitch to snap to. Pavement and carpet
      // carry a 1 m collider (clearance, not thickness), so extruded literally
      // they'd ring every path in kerbs. They lie flat instead.
      h = MIN_BOX_H;
    } else {
      if (STRUCTURE_CATEGORIES.has(cls.id)) {
        // Wall colliders dip ~0.11 m below the floor; the piece sits on it.
        baseY = e.pos?.[1] ?? 0;
      }
      // Cap at the storey. A collider is a clearance volume, not a visual
      // extent: window and entrance walls measure 7.9 m against a plain wall's
      // 5 m (the arch above the opening is in the AABB), a wall banner 12.4 m,
      // a forge 8 m. Extruded literally those punch through the storey above
      // and turn a windowed wall into battlements. Nothing built inside a
      // castle can exceed its storey, so anything that claims to is slop.
      // Plants are the exception — a tree really is taller than the wall.
      if (cls.id !== 'plant') h = Math.min(h, FLOOR_HEIGHT_M);
      if (cls.id === 'stairs') h = Math.min(h, STAIR_PLATFORM_M);
      if (cls.id === 'wall' || cls.id === 'fence') h *= wallScale;
    }

    const [tx, tz] = snapStructure(e, cls);
    const x0 = tx - w / 2;
    const z0 = tz - d / 2;
    boxes.push({
      x0, z0, w, d,
      by: baseY,
      h,
      layerId,
      prefab: e.prefab,
      depth: x0 + z0,
      // Projected silhouette bounds, in the same tile-sized units isoProject
      // returns. Precomputed because the painter culls against the viewport
      // every frame: at high zoom that skips most of the scene, which is the
      // difference between a smooth drag and a second-long stall.
      ...isoBounds(x0, z0, w, d, baseY, h),
    });
    counts.set(layerId, (counts.get(layerId) ?? 0) + 1);
    placed++;
    if (baseY < yMin) yMin = baseY;
  }

  // Painter's order: back to front. Depth in this projection grows with
  // (x + z), so each box sorts on the `depth` its builder recorded — the FAR
  // corner for most things, which also means a large box (a floor tile) sorts
  // before the small ones standing on it. Ties break by base height, then by
  // the plan's own layer order.
  boxes.sort((a, b) =>
    (a.depth - b.depth) ||
    (a.by - b.by) ||
    ((LAYER_RANK.get(a.layerId) ?? 0) - (LAYER_RANK.get(b.layerId) ?? 0)));

  return {
    boxes,
    counts,
    placed,
    yMin: Number.isFinite(yMin) ? yMin : 0,
  };
}

/**
 * Size the iso surface for a scene.
 *
 * Projects every box corner that can touch the silhouette, takes the extent,
 * and derives a pixel cell from the caller's target width — the same
 * contract as computePanelLayout, so the viewer can size its canvas the same
 * way in either mode.
 *
 * `originX`/`originY` are the translation (in px) that puts the scene's
 * top-left at 0,0; the painter applies them before drawing.
 *
 * @param {ReturnType<typeof buildIsoScene>} scene
 * @param {{ targetWidth?: number, minCell?: number, maxCell?: number, pad?: number }} [opts]
 */
export function computeIsoLayout(scene, opts = {}) {
  const targetWidth = opts.targetWidth ?? 800;
  const minCell     = opts.minCell ?? 1;
  const maxCell     = opts.maxCell ?? 8;
  const pad         = opts.pad ?? 8;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const b of scene.boxes) {
    if (b.u0 < minX) minX = b.u0;
    if (b.u1 > maxX) maxX = b.u1;
    if (b.v0 < minY) minY = b.v0;
    if (b.v1 > maxY) maxY = b.v1;
  }
  if (!Number.isFinite(minX)) { minX = maxX = minY = maxY = 0; }

  const unitsW = Math.max(1, maxX - minX);
  const unitsH = Math.max(1, maxY - minY);
  const cell = Math.max(minCell, Math.min(maxCell, targetWidth / unitsW));

  return {
    cell,
    originX: pad - minX * cell,
    originY: pad - minY * cell,
    drawW: Math.ceil(unitsW * cell) + pad * 2,
    drawH: Math.ceil(unitsH * cell) + pad * 2,
  };
}
