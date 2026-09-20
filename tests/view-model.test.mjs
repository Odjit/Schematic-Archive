/**
 * Unit tests for the build-time view model (src/lib/view-model.mjs).
 *
 * The contract that matters: a schematic rendered through
 * buildViewModel -> hydrateViewModel must produce the same panel as the raw
 * schematic rendered through buildCategoryLookup. If that ever drifts, the
 * interactive viewer and the static SVG stop agreeing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCategoryLookup,
  buildPanel,
  computePanelLayout,
  detectGridPitch,
  detectStairRuns,
} from '../src/lib/floorplan.mjs';
import { buildViewModel, hydrateViewModel, VIEW_MODEL_VERSION } from '../src/lib/view-model.mjs';

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
    StairEnd:   { category: 'stairs', w: 6, d: 6, y0: 0, y1: 5, kind: 'End',   dir: 'North' },
    Pavement_T_Section: { category: 'pavement', w: 5, d: 5, y0: 0, y1: 1 },
  },
};

const ent = (prefab, x, z, y = 0, rot = [0, 0, 0]) =>
  ({ prefab, tilePos: [x, z], pos: [x, y, z], rot });

const SCHEMATIC = {
  boundingBox: { min: [0, 0, 0], max: [40, 10, 40] },
  entities: [
    ent('Floor', 0, 0), ent('Floor', 10, 0), ent('Floor', 20, 0),
    ent('Floor', 0, 10), ent('Floor', 10, 10), ent('Floor', 20, 10),
    ent('Wall', 0, 0, 0, [0, 90, 0]),
    ent('Wall', 10, 0, 5),
    ent('StairStart', 20, 20), ent('StairEnd', 20, 30),
    ent('Pavement_T_Section', 0, 20, 0, [0, 180, 0]),
    ent('CHAR_Militia_Guard', 30, 30),   // name-fallback classification
    ent('NopePrefab', 30, 0),            // unknown
    { prefab: 'Item_Ingredient_Plant', pos: [1, 2, 3] },  // no tilePos
  ],
};

const panelOf = (schematic, lookup) => {
  const layout = computePanelLayout(schematic);
  const pitch = detectGridPitch(schematic.entities, lookup);
  const geom = { minTX: layout.minTX, maxTZ: layout.maxTZ, cell: layout.cell, pitch };
  return buildPanel(schematic.entities, lookup, geom, null, { collectHits: true });
};

// --------------------------------------------------------------------------
test('view model drops entities with no tilePos, keeps the rest', () => {
  const vm = buildViewModel(SCHEMATIC, TABLE);
  assert.equal(vm.schemaVersion, VIEW_MODEL_VERSION);
  assert.equal(vm.entities.length, SCHEMATIC.entities.length - 1);
  // Only the categories this build actually places.
  assert.deepEqual(
    vm.categories.map(c => c.id).sort(),
    ['floor', 'other', 'pavement', 'servant', 'stairs', 'wall'],
  );
});

test('view model carries resolved footprints, not raw table entries', () => {
  const vm = buildViewModel(SCHEMATIC, TABLE);
  const byName = new Map(vm.prefabs.map(p => [p.n, p]));
  assert.deepEqual(
    { c: byName.get('Wall').c, w: byName.get('Wall').w, d: byName.get('Wall').d },
    { c: 'wall', w: 5, d: 1 },
  );
  // Stair kind survives (detectStairRuns needs it).
  assert.equal(byName.get('StairStart').k, 'Start');
  // Ribbon shape is precomputed from the name.
  assert.equal(byName.get('Pavement_T_Section').s, 'tee');
  // Name-fallback classification happens at build time, so the browser never
  // needs the fallback table.
  assert.equal(byName.get('CHAR_Militia_Guard').c, 'servant');
  assert.equal(byName.get('CHAR_Militia_Guard').u, undefined); // recognized
  assert.equal(byName.get('NopePrefab').c, 'other');
  assert.equal(byName.get('NopePrefab').u, true);
});

test('view model round-trips to an identical panel', () => {
  const direct = panelOf(SCHEMATIC, buildCategoryLookup(TABLE));
  const { schematic, lookup } = hydrateViewModel(buildViewModel(SCHEMATIC, TABLE));
  const viaModel = panelOf(schematic, lookup);

  assert.equal(viaModel.placed, direct.placed);
  assert.deepEqual([...viaModel.counts].sort(), [...direct.counts].sort());
  for (const [layerId, bucket] of direct.layers) {
    assert.deepEqual(
      [...viaModel.layers.get(layerId).keys()].sort(),
      [...bucket.keys()].sort(),
      `layer ${layerId} rects differ`,
    );
  }
  // Hover tooltips read hit.prefab, so prefab names must survive the trip.
  assert.deepEqual(
    viaModel.hits.map(h => h.prefab).sort(),
    direct.hits.map(h => h.prefab).sort(),
  );
});

test('round-trip preserves stair runs (kind + Y both survive)', () => {
  const lookup = buildCategoryLookup(TABLE);
  const pitch = detectGridPitch(SCHEMATIC.entities, lookup);
  const direct = detectStairRuns(SCHEMATIC.entities, lookup, pitch);

  const hydrated = hydrateViewModel(buildViewModel(SCHEMATIC, TABLE));
  const viaModel = detectStairRuns(
    hydrated.schematic.entities,
    hydrated.lookup,
    detectGridPitch(hydrated.schematic.entities, hydrated.lookup),
  );

  assert.equal(viaModel.length, direct.length);
  assert.deepEqual(viaModel.map(r => r.cells), direct.map(r => r.cells));
  assert.deepEqual(viaModel.map(r => r.path), direct.map(r => r.path));
  assert.deepEqual(viaModel.map(r => r.minY), direct.map(r => r.minY));
});

test('rotation survives at the 90-degree granularity the renderer uses', () => {
  const rotated = {
    boundingBox: SCHEMATIC.boundingBox,
    // -66.0131 is a real decorative angle from the sample builds; the
    // renderer snaps it, so the rounded value must snap the same way.
    entities: [ent('Wall', 5, 5, 0, [0, -66.0131, 0]), ent('Wall', 15, 5, 0, [0, 90.00001, 0])],
  };
  const direct = panelOf(rotated, buildCategoryLookup(TABLE));
  const { schematic, lookup } = hydrateViewModel(buildViewModel(rotated, TABLE));
  const viaModel = panelOf(schematic, lookup);
  assert.deepEqual(
    [...viaModel.layers.get('wall').keys()].sort(),
    [...direct.layers.get('wall').keys()].sort(),
  );
});
