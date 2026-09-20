/**
 * view-model.mjs — the slim, build-time render payload for one schematic.
 *
 * The Canvas viewer used to fetch the raw `.schematic` (2.5 MB for a large
 * build) plus the shared `render-prefabs.json` (418 KB) and do all the
 * classification in the browser. Over 95% of that was never read: the
 * renderer only needs a prefab name, a tile position, a world Y, and a Y
 * rotation per entity, plus the resolved footprint of each *distinct* prefab.
 *
 * So the build resolves the prefab table once (`buildViewModel`) and writes a
 * per-entry `view.json`; the browser rehydrates it (`hydrateViewModel`) into
 * exactly the shapes `floorplan.mjs` already consumes. Same geometry code on
 * both sides, ~14 KB gzipped instead of ~190 KB, and no classification pass
 * on the main thread.
 *
 * Format (schemaVersion 1):
 *
 *   {
 *     schemaVersion: 1,
 *     generatedAt: "2026-…Z",
 *     boundingBox: { min: [tileX, worldY, tileZ], max: [...] },
 *     categories: [ { id, label, color } ],   // only those this build uses
 *     prefabs:    [ { n, c, w, d, y0, y1, k?, dir?, s?, u? } ],
 *     entities:   [ [prefabIndex, tileX, tileZ, worldY, rotYDeg], … ]
 *   }
 *
 * Field names are terse because they repeat per distinct prefab; the entity
 * tuples carry the bulk of the bytes and repeat per placed piece.
 *
 * Entities with no `tilePos` are dropped at build time. The renderer already
 * skipped them (`buildPanel`'s skippedNoTile counter), and they're a tenth of
 * a large file: spawned inventory backers, stored items, servants.
 */
import { buildCategoryLookup, UNKNOWN_CATEGORY } from './floorplan.mjs';

/** Bump when the on-disk shape changes incompatibly. */
export const VIEW_MODEL_VERSION = 1;

// Tile positions are integers in every file we've seen, world Y runs to ~7
// decimals (15.1245365). Three decimals is well inside the 0.05 m epsilon the
// Y-band filter uses, and rotation only ever matters snapped to 90°.
const r3 = (v) => Math.round(v * 1000) / 1000;

/**
 * Resolve a schematic + prefab table into the slim payload above.
 *
 * Pure: no I/O, no DOM. The caller writes the returned object as JSON.
 *
 * @param {object} schematic parsed .schematic JSON
 * @param {object} prefabTable parsed render-prefabs.json
 * @returns {object} the view model
 */
export function buildViewModel(schematic, prefabTable) {
  const { lookup } = buildCategoryLookup(prefabTable);

  const placed = (schematic.entities ?? []).filter(e => e.tilePos);

  // Distinct prefabs, sorted so the file diffs cleanly between rebuilds.
  const names = [...new Set(placed.map(e => e.prefab))].sort();
  const indexOf = new Map(names.map((n, i) => [n, i]));

  const usedCategories = new Set();
  const prefabs = names.map((n) => {
    const c = lookup(n);
    usedCategories.add(c.id);
    /** @type {any} */
    const rec = { n, c: c.id, w: c.w, d: c.d, y0: r3(c.y0), y1: r3(c.y1) };
    if (c.kind)  rec.k   = c.kind;
    if (c.dir)   rec.dir = c.dir;
    if (c.shape) rec.s   = c.shape;
    if (!c.known) rec.u  = true;
    return rec;
  });

  const entities = placed.map(e => [
    indexOf.get(e.prefab),
    e.tilePos[0],
    e.tilePos[1],
    r3(e.pos?.[1] ?? 0),
    Math.round(e.rot?.[1] ?? 0),
  ]);

  return {
    schemaVersion: VIEW_MODEL_VERSION,
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    boundingBox: schematic.boundingBox,
    categories: prefabTable.categories.filter(c => usedCategories.has(c.id)),
    prefabs,
    entities,
  };
}

/**
 * Rehydrate a view model into the shapes `floorplan.mjs` expects.
 *
 * `schematic` is a stand-in for the parsed file with just the two fields the
 * geometry code reads (boundingBox + entities); `lookup` is a drop-in for
 * `buildCategoryLookup`'s return, backed by the precomputed records instead
 * of re-resolving names against the full prefab table.
 *
 * @param {object} vm parsed view.json
 * @returns {{ schematic: object, lookup: object }}
 */
export function hydrateViewModel(vm) {
  const byId = new Map(vm.categories.map(c => [c.id, c]));
  const fallbackCategory =
    byId.get(UNKNOWN_CATEGORY) ??
    { id: UNKNOWN_CATEGORY, label: 'Other', color: '#cccccc' };

  // Resolve each prefab record once into the PrefabLookupResult shape, so the
  // per-entity lookup in buildPanel is a single Map hit.
  const resolved = vm.prefabs.map((p) => {
    const cat = byId.get(p.c) ?? fallbackCategory;
    return {
      id: cat.id,
      color: cat.color,
      label: cat.label,
      w: p.w,
      d: p.d,
      y0: p.y0,
      y1: p.y1,
      kind: p.k,
      dir: p.dir,
      shape: p.s,
      known: !p.u,
    };
  });
  const byName = new Map(vm.prefabs.map((p, i) => [p.n, resolved[i]]));
  const unknownResult = {
    id: fallbackCategory.id,
    color: fallbackCategory.color,
    label: fallbackCategory.label,
    w: 1, d: 1, y0: 0, y1: 1,
    known: false,
  };

  // `pos` and `rot` are padded to the schematic's 3-component shape, but only
  // the components the geometry code actually reads carry data: pos[1] (world
  // Y, for band filtering) and rot[1] (Y rotation, snapped to 90° downstream).
  // World X/Z are omitted because they're redundant with tilePos, and the X/Z
  // Euler components are always 0 in castle schematics.
  const entities = vm.entities.map(([p, x, z, y, rot]) => ({
    prefab: vm.prefabs[p]?.n ?? '',
    tilePos: [x, z],
    pos: [0, y, 0],
    rot: [0, rot, 0],
  }));

  return {
    schematic: { boundingBox: vm.boundingBox, entities },
    lookup: {
      lookup: (name) => byName.get(name) ?? unknownResult,
      categories: vm.categories,
    },
  };
}
