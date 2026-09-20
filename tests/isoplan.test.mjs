/**
 * Unit tests for the isometric scene builder (src/lib/isoplan.mjs).
 *
 * What matters here: pieces come out at their true size (the prefab table's
 * w/d are metres, tile space is half-metres), the paint order is back to
 * front, and the precomputed silhouette bounds the painter culls against
 * actually match the projected corners.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCategoryLookup,
  buildPanel,
  TILES_PER_METRE,
} from '../src/lib/floorplan.mjs';
import { buildIsoScene, computeIsoLayout, isoProject } from '../src/lib/isoplan.mjs';

const TABLE = {
  categories: [
    { id: 'floor',    label: 'Floor',    color: '#a' },
    { id: 'wall',     label: 'Wall',     color: '#b' },
    { id: 'pavement', label: 'Pavement', color: '#e' },
    { id: 'storage',  label: 'Storage',  color: '#f' },
    { id: 'other',    label: 'Other',    color: '#0' },
  ],
  prefabs: {
    // A 5 m wall: 10 tiles long, 2 deep, 5 m tall.
    Wall:     { category: 'wall',     w: 5, d: 1, y0: 0, y1: 5 },
    Floor:    { category: 'floor',    w: 6, d: 6, y0: 0, y1: 0 },
    Pavement: { category: 'pavement', w: 5, d: 5, y0: 0, y1: 1 },
    Chest:    { category: 'storage',  w: 2, d: 1, y0: 0, y1: 1.5 },
  },
};
const lookup = buildCategoryLookup(TABLE);
const ent = (prefab, x, z, y = 0, rot = [0, 0, 0]) =>
  ({ prefab, tilePos: [x, z], pos: [0, y, 0], rot });

const boxFor = (scene, prefab) => scene.boxes.find(b => b.prefab === prefab);

// --------------------------------------------------------------------------
test('footprints scale from metres to tiles', () => {
  const scene = buildIsoScene([ent('Wall', 100, 100)], lookup, {}, null);
  const b = boxFor(scene, 'Wall');
  // 5 m x 1 m collider -> 10 x 2 tiles, centered on the tile position.
  assert.equal(b.w, 5 * TILES_PER_METRE);
  assert.equal(b.d, 1 * TILES_PER_METRE);
  assert.equal(b.x0, 100 - b.w / 2);
  assert.equal(b.z0, 100 - b.d / 2);
  assert.equal(b.h, 5); // height stays in metres
});

test('rotation swaps the footprint axes', () => {
  const scene = buildIsoScene([ent('Wall', 0, 0, 0, [0, 90, 0])], lookup, {}, null);
  const b = boxFor(scene, 'Wall');
  assert.equal(b.w, 1 * TILES_PER_METRE);
  assert.equal(b.d, 5 * TILES_PER_METRE);
});

test('floors snap to the placement cell', () => {
  const scene = buildIsoScene([ent('Floor', 0, 0)], lookup, { pitch: 10 }, null);
  const b = boxFor(scene, 'Floor');
  assert.equal(b.w, 10);
  assert.equal(b.d, 10);
});

test('paths stay thin, matching the plan rather than filling the tile', () => {
  const entities = [ent('Pavement', 0, 0), ent('Pavement', 10, 0)];
  const geom = { pitch: 10 };
  const scene = buildIsoScene(entities, lookup, geom, null);

  // Same rects the plan draws: two 5x5 base tiles and a 10x5 bridge, never a
  // filled 10x10 cell. (A path in game is a walkway across the tile.)
  const paths = scene.boxes.filter(b => b.layerId === 'pavement');
  assert.equal(paths.length, 3);
  assert.ok(paths.every(b => b.d === 5), 'thickness stays at the collider width');
  assert.ok(paths.some(b => b.w === 10), 'a bridge spans the gap to the neighbour');
  assert.ok(!paths.some(b => b.w === 10 && b.d === 10), 'never a filled cell');

  // Flat: a 1 m pavement collider is clearance, not kerb height.
  assert.ok(paths.every(b => b.h < 0.1));

  // The plan and the iso view agree piece for piece.
  const panel = buildPanel(
    entities, lookup, { minTX: 0, maxTZ: 100, cell: 1, pitch: 10 }, null,
  );
  assert.equal(panel.layers.get('pavement').size, paths.length);
  assert.equal(panel.counts.get('pavement'), scene.counts.get('pavement'));
});

test('placed counts pieces, not the rects a path expands into', () => {
  const entities = [ent('Pavement', 0, 0), ent('Pavement', 10, 0), ent('Wall', 40, 40)];
  const scene = buildIsoScene(entities, lookup, { pitch: 10 }, null);
  assert.equal(scene.placed, 3);
  assert.ok(scene.boxes.length > scene.placed, 'bridges add rects beyond the pieces');
});

test('wallHeightScale only touches walls', () => {
  const entities = [ent('Wall', 0, 0), ent('Chest', 20, 20)];
  const full = buildIsoScene(entities, lookup, {}, null);
  const cut  = buildIsoScene(entities, lookup, {}, null, { wallHeightScale: 0.5 });
  assert.equal(boxFor(cut, 'Wall').h, boxFor(full, 'Wall').h * 0.5);
  assert.equal(boxFor(cut, 'Chest').h, boxFor(full, 'Chest').h);
});

test('boxes are sorted back to front', () => {
  const scene = buildIsoScene([
    ent('Chest', 60, 60), ent('Chest', 0, 0), ent('Chest', 30, 30),
  ], lookup, {}, null);
  const depth = scene.boxes.map(b => b.x0 + b.z0);
  for (let i = 1; i < depth.length; i++) {
    assert.ok(depth[i] >= depth[i - 1], 'depth must not decrease along the scene');
  }
});

test('a big flat tile sorts before the small box standing on it', () => {
  // Floor tile covering the cell, chest centered on it. The floor has to paint
  // first or it covers the chest.
  const scene = buildIsoScene(
    [ent('Chest', 5, 5, 0.1), ent('Floor', 5, 5)], lookup, { pitch: 10 }, null,
  );
  assert.equal(scene.boxes[0].prefab, 'Floor');
  assert.equal(scene.boxes[1].prefab, 'Chest');
});

test('precomputed bounds match the projected corners', () => {
  const scene = buildIsoScene(
    [ent('Wall', 40, 12, 5), ent('Chest', 3, 30, 0), ent('Floor', 0, 0)],
    lookup, { pitch: 10 }, null,
  );
  for (const b of scene.boxes) {
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const tx of [b.x0, b.x0 + b.w]) {
      for (const tz of [b.z0, b.z0 + b.d]) {
        for (const y of [b.by, b.by + b.h]) {
          const [u, v] = isoProject(tx, tz, y);
          u0 = Math.min(u0, u); u1 = Math.max(u1, u);
          v0 = Math.min(v0, v); v1 = Math.max(v1, v);
        }
      }
    }
    const near = (a, c) => Math.abs(a - c) < 1e-9;
    assert.ok(near(b.u0, u0) && near(b.u1, u1), `${b.prefab} horizontal bounds`);
    assert.ok(near(b.v0, v0) && near(b.v1, v1), `${b.prefab} vertical bounds`);
  }
});

test('Y filter drops out-of-band pieces, same as the plan', () => {
  const entities = [ent('Wall', 0, 0, 0), ent('Wall', 20, 0, 10)];
  // Ground band [0,5): the wall at y=10 has its center at 12.5 and is dropped.
  const scene = buildIsoScene(entities, lookup, {}, { mode: 'center', y0: 0, y1: 5 });
  assert.equal(scene.placed, 1);
  assert.equal(scene.counts.get('wall'), 1);
});

test('computeIsoLayout covers every box with the requested padding', () => {
  const scene = buildIsoScene(
    [ent('Wall', 0, 0), ent('Chest', 80, 60, 5)], lookup, {}, null,
  );
  const pad = 8;
  const layout = computeIsoLayout(scene, { targetWidth: 400, pad });
  for (const b of scene.boxes) {
    const left   = b.u0 * layout.cell + layout.originX;
    const right  = b.u1 * layout.cell + layout.originX;
    const top    = b.v0 * layout.cell + layout.originY;
    const bottom = b.v1 * layout.cell + layout.originY;
    assert.ok(left >= pad - 1e-6 && top >= pad - 1e-6, 'inside the top-left pad');
    assert.ok(right <= layout.drawW - pad + 1, 'inside the right edge');
    assert.ok(bottom <= layout.drawH - pad + 1, 'inside the bottom edge');
  }
});

test('an empty scene still yields a usable layout', () => {
  const scene = buildIsoScene([], lookup, {}, null);
  const layout = computeIsoLayout(scene);
  assert.equal(scene.placed, 0);
  assert.ok(layout.drawW > 0 && layout.drawH > 0);
  assert.ok(Number.isFinite(layout.originX) && Number.isFinite(layout.originY));
});
