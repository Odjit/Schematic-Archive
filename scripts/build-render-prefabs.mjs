#!/usr/bin/env node
/**
 * build-render-prefabs.mjs
 *
 * Reads data/render-prefabs.raw.json (dumped from the KindredExtract mod via
 * `.dump renderprefabs`) and produces src/data/render-prefabs.json — a slim,
 * classified lookup used by the floor-plan renderer.
 *
 * Why split this out:
 *   - The mod dump is *raw facts* (name + component flags + tile bounds +
 *     height). It changes only when the game version changes.
 *   - Classification is a pure function over names + flags. Iterating on
 *     buckets and colors should not require re-running the in-game dump.
 *
 * Output schema (slim form, what the renderer consumes):
 *   {
 *     schemaVersion: 4,
 *     generatedAt:   "...Z",
 *     sourceGeneratedAt: "...Z",   // from the raw dump
 *     prefabCount:   number,
 *     categories:    [ { id, label, color }, ... ],
 *     prefabs: {
 *       "TM_Castle_Wall_Tier02_Stone": {
 *         category: "wall" | "floor" | ...,
 *         w:        number,    // footprint width  in tile units (X axis, unrotated)
 *         d:        number,    // footprint depth  in tile units (Z axis, unrotated)
 *         y0:       number,    // collider min Y relative to entity origin (meters)
 *         y1:       number,    // collider max Y relative to entity origin (meters)
 *         dir?:     string,    // present for stairs: "North"|"East"|"South"|"West"
 *         kind?:    string     // present for stairs: "Start"|"End"|...
 *       }
 *     }
 *   }
 *
 * Schema-v3 changes (the why):
 *   - tilePosition-only rendering looked sparse (single-tile dots per piece).
 *   - The 4-tile uniform-block heuristic in v2 looked blocky.
 *   - Per-piece w/d come from the prefab's PhysicsCollider AABB in the raw
 *     dump (Unity.Physics CalculateAabb()). World units are meters; V Rising
 *     places tiles on a 1m grid that the schematic stores in `tilePos`, so
 *     no conversion is needed — meters map directly to tile units here.
 *   - Stairs carry an explicit Direction component on the prefab which the
 *     renderer prefers over decoding the schematic entity's rotation
 *     quaternion-as-Euler.
 *
 * Run via:  pnpm run build-render-prefabs
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');
const RAW_PATH  = resolve(ROOT, 'data',     'render-prefabs.raw.json');
const OUT_PATH  = resolve(ROOT, 'src/data', 'render-prefabs.json');

const log  = (...a) => console.log('[build-render-prefabs]', ...a);
const warn = (...a) => console.warn('[build-render-prefabs] WARN:', ...a);

// ---------------------------------------------------------------------------
// Category table — single source of truth for the renderer's color legend.
// Order matters for the legend; classifier order is independent.
// ---------------------------------------------------------------------------
const CATEGORIES = [
  { id: 'heart',       label: 'Castle Heart', color: '#d63b3b' },
  { id: 'wall',        label: 'Wall',         color: '#6b6b6b' },
  { id: 'floor',       label: 'Floor',        color: '#c9b48a' },
  { id: 'roof',        label: 'Roof',         color: '#7a4434' },
  { id: 'door',        label: 'Door',         color: '#b78b3a' },
  { id: 'stairs',      label: 'Stairs',       color: '#a08c5f' },
  { id: 'workstation', label: 'Workstation',  color: '#3a7ab7' },
  { id: 'storage',     label: 'Storage',      color: '#7a5fbe' },
  { id: 'coffin',      label: 'Coffin',       color: '#412a52' },
  { id: 'teleporter',  label: 'Teleporter',   color: '#39b7a7' },
  { id: 'light',       label: 'Light',        color: '#f0c060' },
  { id: 'plant',       label: 'Plant',        color: '#4f9e4a' },
  { id: 'fence',       label: 'Fence / Chain', color: '#8a7a5a' },
  { id: 'wall-decor',  label: 'Wall decor',   color: '#a0a0a0' },
  { id: 'floor-decor', label: 'Floor decor',  color: '#b8a878' },
  { id: 'decoration',  label: 'Decoration',   color: '#9a9a9a' },
  { id: 'other',       label: 'Other',        color: '#cccccc' },
];

const CATEGORY_IDS = new Set(CATEGORIES.map(c => c.id));

// ---------------------------------------------------------------------------
// Classifier — name-first because the prefab archetype lacks the runtime
// tags (CastleWall, CastleFloor, CastleFloorRoof) that get attached at
// placement time. Components like CastleHeart and CastleWorkstation *are*
// reliable on the prefab and are used as the strongest signal.
//
// Rules are tried in order; first non-falsy id wins.
//
// Key convention used by the regexes:
//   - V Rising prefab names are underscore-separated identifiers, e.g.
//     "TM_Castle_Wall_Tier02_Stone_Window" or "Chain_FortressOfLight_Railing_02".
//   - "(?:^|_)Keyword" means "Keyword starts a segment" — this avoids the
//     classic substring trap where "Light" matches inside "FortressOfLight".
// ---------------------------------------------------------------------------
const RULES = [
  // 1) Castle heart — only the heart entity has this component.
  (n, f) => f.castleHeart && 'heart',

  // 2) Decor variants MUST come before generic Wall/Floor/Roof name rules,
  //    otherwise paintings would get bucketed as walls.
  (n)    => /(?:^|_)WallDecor(?:_|$)/.test(n)                && 'wall-decor',
  (n)    => /(?:^|_)CeilingDecor(?:_|$)/.test(n)             && 'wall-decor',
  (n)    => /(?:^|_)FloorDecor(?:_|$)/.test(n)               && 'floor-decor',

  // 3) Specific station-shaped things win over the generic workstation
  //    flag — servant coffins, dressers, etc. all set CastleWorkstation
  //    internally but read as something more specific to a builder.
  (n)    => /Coffin/.test(n)                                 && 'coffin',
  // Loose tail-match catches "GhostCrate_02", "WoodenBarrel_01", etc.
  (n)    => /(?:Storage|Chest|Container|Stash|Crate|Barrel)(?=_|\d|$)/.test(n) && 'storage',
  (n)    => /(?:Teleport|Waygate|Portal|Waypoint)/.test(n)   && 'teleporter',

  // 4) Real workstations — flag OR explicit "Workstation"/"Forge"/"Refine" tail.
  (n, f) => (f.workstation || /(?:Workstation|Forge|Refine)(?=_|\d|$)/.test(n)) && 'workstation',

  // 5) Build-piece shapes by name. Roof BEFORE floor because
  //    "TM_Castle_Floor_InvisibleRoofBlocker" reads as both.
  //    "Walls?(?=_|\d|$)" intentionally matches both standalone segments
  //    ("Wall_Tier01") and CamelCase tails ("ShortWall_03",
  //    "OuterWalls_Tower01") — that's how V Rising names compound pieces.
  (n)    => /(?:Roof|Roofing)/.test(n)                              && 'roof',
  (n)    => /(?:^|_)Stairs(?:_|\d|$)/.test(n)                       && 'stairs',
  (n)    => /(?:^|_)Floor(?:_|\d|$)/.test(n)                        && 'floor',
  (n)    => /Walls?(?=_|\d|$)|Fortification(?=_|\d|$)/.test(n)      && 'wall',
  (n, f) => (f.door || /Door(?=_|\d|$)|Gate(?=_|\d|$)/.test(n)) && 'door',

  // 6) Fence / railing / hedge — loose tail catches "VineyardFence",
  //    "IronFencePole", "Hedgerow01".
  (n)    => /(?:Fence|Hedge|Hedgerow|Vineyard|Railing)(?=_|\d|$)/.test(n) && 'fence',

  // 7) Ambient props. "Light" by itself is intentionally dropped because
  //    biome names like "SilverLight" collide and can't be cleanly excluded;
  //    we rely on concrete fixture keywords instead. Most real light fixtures
  //    carry one (Candle/Lamp/Brazier/...).
  (n)    => /(?:Candle|Lamp|LampPost|Brazier|Sconce|Chandelier|Lantern|Torch)(?=_|\d|$)/.test(n) && 'light',
  // Loose tail-match: catches both segment-start ("_Tree_") and CamelCase
  // compounds ("HornbeamTree_02", "PlantfiberBush_03").
  (n)    => /(?:Plant|Tree|Bush|Flower|Sapling|Shrub|Mushroom|Grass)(?=_|\d|$)/.test(n) && 'plant',

  // 8) Recognised system/internal prefabs that aren't really placeable visuals.
  //    Reserved for things that show up in entity dumps but never as visible
  //    castle props — InvisibleHelper, WarEvent triggers, hidden objects.
  (n)    => /(?:HiddenObject|InvisibleHelper|EmptyObject|WarEvent|DestroyTrigger|NetworkedGateObject)/.test(n) && 'other',

  // 9) Catch-all. Chain_* pieces with no tilePosition (tables, banners,
  //    crates attached via parent-child) still end up here as decoration —
  //    they're visible props, just not on the tile grid.
  ()     => 'decoration',
];

function classify(name, flags) {
  for (const rule of RULES) {
    const id = rule(name, flags);
    if (id) {
      if (!CATEGORY_IDS.has(id)) {
        throw new Error(`classifier produced unknown category "${id}" for "${name}"`);
      }
      return id;
    }
  }
  return 'other';
}

// ---------------------------------------------------------------------------
/**
 * Pull a usable {w, d, h} footprint out of a raw prefab entry.
 *
 * Returns null when there's no AABB or it's degenerate, so the renderer can
 * fall back to a 1x1 marker. We clamp to 1 tile minimum on both axes because
 * sub-tile pieces (props, decorations) still need to read on the floor plan.
 */
function deriveFootprint(rawEntry) {
  const min = rawEntry.aabbMin;
  const max = rawEntry.aabbMax;
  if (!Array.isArray(min) || !Array.isArray(max)) return null;
  const w = max[0] - min[0];
  const d = max[2] - min[2];
  if (!isFinite(w) || !isFinite(d)) return null;
  // Zero-sized AABBs (some chains, some particle-only prefabs) — treat as
  // "no useful dimensions" so the renderer falls back to 1x1.
  if (w <= 0.01 && d <= 0.01) return null;
  return {
    w: Math.max(1, Math.round(w)),
    d: Math.max(1, Math.round(d)),
    // Y bounds relative to entity origin, kept as floats so slice-band
    // overlap math is exact. Rounded to 0.1 m to keep the file small.
    y0: Math.round(min[1] * 10) / 10,
    y1: Math.round(max[1] * 10) / 10,
  };
}

async function main() {
  log(`reading ${relative(ROOT, RAW_PATH)}`);
  const raw = JSON.parse(await readFile(RAW_PATH, 'utf8'));

  const prefabs = {};
  const bucketCounts = Object.fromEntries(CATEGORIES.map(c => [c.id, 0]));
  let dupes = 0;
  let withFootprint = 0;
  let withoutFootprint = 0;

  for (const entry of Object.values(raw.prefabs)) {
    if (prefabs[entry.name]) { dupes++; continue; }
    const category = classify(entry.name, entry.flags ?? {});
    const slim = { category };
    const fp = deriveFootprint(entry);
    if (fp) {
      slim.w  = fp.w;
      slim.d  = fp.d;
      slim.y0 = fp.y0;
      slim.y1 = fp.y1;
      withFootprint++;
    } else {
      withoutFootprint++;
    }
    if (entry.stairsDirection) slim.dir  = entry.stairsDirection;
    if (entry.stairsType)      slim.kind = entry.stairsType;
    prefabs[entry.name] = slim;
    bucketCounts[category]++;
  }

  const slim = {
    schemaVersion: 4,
    generatedAt: new Date().toISOString(),
    sourceGeneratedAt: raw.generatedAt,
    prefabCount: Object.keys(prefabs).length,
    footprintCoverage: {
      withAabb:    withFootprint,
      withoutAabb: withoutFootprint,
    },
    categories: CATEGORIES,
    prefabs,
  };

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(slim) + '\n'); // un-pretty: file is consumed, not edited

  log(`wrote ${relative(ROOT, OUT_PATH)} (${slim.prefabCount} prefabs${dupes ? `, ${dupes} duplicate names skipped` : ''})`);
  log(`footprint coverage: ${withFootprint} with AABB / ${withoutFootprint} without (will render as 1x1)`);
  log('category distribution:');
  for (const c of CATEGORIES) {
    const n = bucketCounts[c.id];
    if (n > 0) console.log(`  ${c.id.padEnd(12)} ${String(n).padStart(5)}`);
  }
}

main().catch(err => {
  console.error('[build-render-prefabs] failed:', err);
  process.exit(1);
});
