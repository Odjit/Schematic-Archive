/**
 * Unit tests for the pure floor-plan lib (src/lib/floorplan.mjs).
 *
 * These lock in the behavior the SVG renderer and the Canvas viewer both
 * depend on — the "regression target" for the lift-and-shift refactor. Run
 * with `npm test` (node --test, no extra deps).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCategoryLookup,
  buildPanel,
  computePanelLayout,
  detectFloors,
  detectGridPitch,
  detectStairRuns,
  ribbonArms,
  swapsWidthDepth,
  FULL_CELL_CATEGORIES,
} from '../src/lib/floorplan.mjs';

// --- Minimal prefab table shared by the synthetic tests. -------------------
const TABLE = {
  categories: [
    { id: 'floor',    label: 'Floor',    color: '#a' },
    { id: 'wall',     label: 'Wall',     color: '#b' },
    { id: 'stairs',   label: 'Stairs',   color: '#c' },
    { id: 'servant',  label: 'Servant',  color: '#d' },
    { id: 'pavement', label: 'Pavement', color: '#e' },
    { id: 'other',    label: 'Other',    color: '#0' },
  ],
  prefabs: {
    Floor:      { category: 'floor',  w: 6, d: 6, y0: 0, y1: 0 },
    Wall:       { category: 'wall',   w: 5, d: 1, y0: 0, y1: 5 },
    StairStart: { category: 'stairs', w: 6, d: 6, y0: 0, y1: 5, kind: 'Start', dir: 'North' },
    StairMid:   { category: 'stairs', w: 6, d: 6, y0: 0, y1: 5, kind: 'Part',  dir: 'North' },
    StairEnd:   { category: 'stairs', w: 6, d: 6, y0: 0, y1: 5, kind: 'End',   dir: 'North' },
    Pavement:   { category: 'pavement', w: 5, d: 5, y0: 0, y1: 1 },
    Pavement_T_Section:     { category: 'pavement', w: 5, d: 5, y0: 0, y1: 1 },
    Pavement_Straight:      { category: 'pavement', w: 5, d: 5, y0: 0, y1: 1 },
    Pavement_Cross_Section: { category: 'pavement', w: 5, d: 5, y0: 0, y1: 1 },
    Door:       { category: 'door', w: 4, d: 4, y0: -1, y1: 5 },
  },
};
const lookup = buildCategoryLookup(TABLE);
const ent = (prefab, x, z, y = 0, rot = [0, 0, 0]) =>
  ({ prefab, tilePos: [x, z], pos: [x, y, z], rot });

// --------------------------------------------------------------------------
test('swapsWidthDepth: 90/270 swap, 0/180 do not', () => {
  assert.equal(swapsWidthDepth([0, 0, 0]), false);
  assert.equal(swapsWidthDepth([0, 90, 0]), true);
  assert.equal(swapsWidthDepth([0, 180, 0]), false);
  assert.equal(swapsWidthDepth([0, 270, 0]), true);
  assert.equal(swapsWidthDepth([0, -90, 0]), true);   // normalizes to 270
  assert.equal(swapsWidthDepth(undefined), false);
});

test('buildCategoryLookup: known vs unknown + kind/dir passthrough', () => {
  const wall = lookup.lookup('Wall');
  assert.equal(wall.id, 'wall');
  assert.equal(wall.w, 5);
  assert.equal(wall.known, true);
  const start = lookup.lookup('StairStart');
  assert.equal(start.kind, 'Start');
  assert.equal(start.dir, 'North');
  const unknown = lookup.lookup('NopePrefab');
  assert.equal(unknown.id, 'other');     // UNKNOWN_CATEGORY fallback
  assert.equal(unknown.known, false);
});

test('buildCategoryLookup: CHAR_* classifies as servant via name fallback', () => {
  const npc = lookup.lookup('CHAR_Militia_Guard');
  assert.equal(npc.id, 'servant');
  assert.equal(npc.known, true);          // recognized, not "unknown"
  assert.equal(npc.w, 2);                 // small marker footprint
  assert.equal(npc.d, 2);
});

test('detectFloors: single-floor build yields no slices', () => {
  const schem = { boundingBox: { min: [0, 0, 0], max: [10, 2, 10] } };
  assert.deepEqual(detectFloors(schem), []);
});

test('detectFloors: multi-floor labels are Ground + Floor N (no "Roof")', () => {
  const schem = { boundingBox: { min: [0, 0, 0], max: [10, 15, 10] } };
  const labels = detectFloors(schem).map(b => b.label);
  assert.deepEqual(labels, ['Ground', 'Floor 2', 'Floor 3']);
});

test('detectGridPitch: modal floor spacing, ignoring non-floor', () => {
  const entities = [
    ent('Floor', 0, 0), ent('Floor', 10, 0), ent('Floor', 20, 0),
    ent('Floor', 0, 10), ent('Floor', 10, 10),
    ent('Wall', 3, 0), ent('Wall', 8, 0), // closer spacing, must be ignored
  ];
  assert.equal(detectGridPitch(entities, lookup), 10);
});

test('detectGridPitch: returns null without enough floor tiles', () => {
  assert.equal(detectGridPitch([ent('Wall', 0, 0)], lookup), null);
});

test('buildPanel: counts per category and full-cell floor sizing', () => {
  assert.ok(FULL_CELL_CATEGORIES.has('floor'));
  const geom = { minTX: 0, maxTZ: 100, cell: 1, pitch: 10 };
  const entities = [ent('Floor', 0, 0), ent('Wall', 0, 0)];
  const panel = buildPanel(entities, lookup, geom, null);
  assert.equal(panel.placed, 2);
  assert.equal(panel.counts.get('floor'), 1);
  assert.equal(panel.counts.get('wall'), 1);
  // Floor renders at the grid pitch (10), not its 6-tile collider.
  const floorRect = [...panel.layers.get('floor').values()][0];
  assert.equal(floorRect.w, 10);
  assert.equal(floorRect.d, 10);
});

test('buildPanel: center-mode yFilter keeps only in-band centers', () => {
  const geom = { minTX: 0, maxTZ: 100, cell: 1, pitch: 10 };
  // Wall at y=0 has center 2.5 (band [0,5)); wall at y=10 center 12.5 (band [10,15)).
  const entities = [ent('Wall', 0, 0, 0), ent('Wall', 5, 0, 10)];
  const ground = buildPanel(entities, lookup, geom, { mode: 'center', y0: 0, y1: 5 });
  assert.equal(ground.placed, 1);
});

test('buildPanel: stairCells overrides yFilter for stairs', () => {
  const geom = { minTX: 0, maxTZ: 100, cell: 1, pitch: 10 };
  // Stair at y=20 would fail a [0,5) center test, but stairCells forces it in.
  const entities = [ent('StairStart', 7, 7, 20)];
  const cells = new Set(['7,7']);
  const panel = buildPanel(entities, lookup, geom, { mode: 'center', y0: 0, y1: 5 }, { stairCells: cells });
  assert.equal(panel.counts.get('stairs'), 1);
  // A different cell set excludes it.
  const empty = buildPanel(entities, lookup, geom, { mode: 'center', y0: 0, y1: 5 }, { stairCells: new Set() });
  assert.equal(empty.counts.get('stairs'), undefined);
});

test('buildPanel: collectHits returns per-entity rects with prefab names', () => {
  const geom = { minTX: 0, maxTZ: 100, cell: 1, pitch: 10 };
  const panel = buildPanel([ent('Wall', 2, 2)], lookup, geom, null, { collectHits: true });
  assert.equal(panel.hits.length, 1);
  assert.equal(panel.hits[0].prefab, 'Wall');
  assert.equal(panel.hits[0].layerId, 'wall');
  assert.ok(panel.hits[0].w > 0 && panel.hits[0].h > 0);
  // No hits collected by default.
  assert.equal(buildPanel([ent('Wall', 2, 2)], lookup, geom, null).hits, null);
});

test('buildPanel: pavement renders as bridged ribbons (connected, thin)', () => {
  const geom = { minTX: 0, maxTZ: 100, cell: 1, pitch: 10 };
  // Two pavement tiles one pitch apart on the same row.
  const entities = [ent('Pavement', 0, 0), ent('Pavement', 10, 0)];
  const panel = buildPanel(entities, lookup, geom, null);
  const rects = [...panel.layers.get('pavement').values()];
  // Two 5x5 base tiles + one 10x5 bridge between them.
  assert.equal(rects.length, 3);
  assert.equal(panel.counts.get('pavement'), 2); // counts pieces, not rects
  const thin = rects.every(r => r.d === 5);       // never as tall as a full cell
  assert.ok(thin, 'ribbon thickness stays at the collider width');
  assert.ok(rects.some(r => r.w === 10), 'a bridge spans the gap to the neighbour');
});

test('ribbonArms: arm directions follow shape + rotation', () => {
  assert.deepEqual(ribbonArms('tee', 0), [[1, 0], [-1, 0], [0, 1]]);
  assert.deepEqual(ribbonArms('straight', 0), [[0, 1], [0, -1]]);
  // +90° maps (dx,dz)->(dz,-dx): a N–S straight becomes E–W.
  assert.deepEqual(ribbonArms('straight', 90), [[1, 0], [-1, 0]]);
  assert.equal(ribbonArms('cross', 270).length, 4);
});

test('buildPanel: T-section bridges its 3 arms, never the missing 4th', () => {
  const geom = { minTX: 0, maxTZ: 100, cell: 1, pitch: 10 };
  // T at origin (arms +X,-X,+Z at rot0) with a neighbour ONLY on its missing
  // -Z side, and that neighbour an E–W straight (no +Z arm) — so neither side
  // bridges. Proves the phantom 4th arm that made T's look like crosses is gone.
  const entities = [
    ent('Pavement_T_Section', 0, 0),
    ent('Pavement_Straight', 0, -10, 0, [0, 90, 0]),
  ];
  const rects = [...buildPanel(entities, lookup, geom, null).layers.get('pavement').values()];
  assert.equal(rects.length, 2); // two base tiles, no bridge across the missing side
});

test('buildPanel: T-section bridges a neighbour on an allowed arm', () => {
  const geom = { minTX: 0, maxTZ: 100, cell: 1, pitch: 10 };
  const entities = [
    ent('Pavement_T_Section', 0, 0),
    ent('Pavement_Cross_Section', 10, 0), // on the T's +X arm
  ];
  const rects = [...buildPanel(entities, lookup, geom, null).layers.get('pavement').values()];
  assert.ok(rects.some(r => r.w === 10 && r.d === 5), 'a bridge spans the +X arm');
});

test('buildPanel: doors render as a slim bar, not the 4x4 collider', () => {
  const geom = { minTX: 0, maxTZ: 100, cell: 1, pitch: 10 };
  const rect = [...buildPanel([ent('Door', 5, 5)], lookup, geom, null)
    .layers.get('door').values()][0];
  assert.equal(rect.w, 4);    // length along the wall kept
  assert.equal(rect.d, 1.5);  // thinned across (was 4)
});

test('detectStairRuns: straight flight is a 2-point centerline', () => {
  const entities = [
    ent('StairStart', 0, 0), ent('StairMid', 10, 0), ent('StairEnd', 20, 0),
  ];
  const runs = detectStairRuns(entities, lookup, 10);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].path.length, 2);
  assert.equal(runs[0].minY, 0);
});

test('detectStairRuns: L-flight bends with axis-aligned segments', () => {
  const entities = [
    ent('StairStart', 0, 0), ent('StairMid', 10, 0), ent('StairEnd', 10, 10),
  ];
  const [run] = detectStairRuns(entities, lookup, 10);
  assert.equal(run.path.length, 3);
  for (let i = 1; i < run.path.length; i++) {
    const a = run.path[i - 1], b = run.path[i];
    const dx = Math.abs(b.x - a.x), dz = Math.abs(b.z - a.z);
    assert.ok(dx < 0.01 || dz < 0.01, 'each segment is axis-aligned');
  }
});

test('detectStairRuns: minY reflects the lowest piece (origin floor)', () => {
  const entities = [
    ent('StairStart', 0, 0, 15), ent('StairEnd', 10, 0, 20),
  ];
  const [run] = detectStairRuns(entities, lookup, 10);
  assert.equal(run.minY, 15);
});

test('computePanelLayout: derives tile extent and clamps cell size', () => {
  const schem = { boundingBox: { min: [0, 0, 0], max: [200, 10, 100] } };
  const layout = computePanelLayout(schem);
  assert.equal(layout.tilesW, 200);
  assert.equal(layout.tilesD, 100);
  assert.equal(layout.drawW, layout.tilesW * layout.cell);
  assert.ok(layout.cell >= 2 && layout.cell <= 8);
});
