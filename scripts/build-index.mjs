#!/usr/bin/env node
/**
 * build-index.mjs
 *
 * Scans builds/<slug>/manifest.json, writes:
 *   - src/data/gallery-index.json   the full list the site reads from
 *   - src/data/search-index.json    a lighter shape (kept for future use)
 *
 * Then copies every entry's screenshots and schematic file into
 * public/entry-assets/<slug>/ so Astro serves them as normal static assets.
 *
 * Run via:  pnpm run build-index
 *
 * Intentionally does NOT validate against the JSON schema; that is the job
 * of scripts/validate-manifests.mjs (used in CI). Keeping this script free of
 * the ajv dependency means a fresh clone can produce an index immediately.
 */

import { readFile, writeFile, mkdir, readdir, stat, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderFloorplan } from './render-floorplan.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const BUILDS_DIR = join(ROOT, 'builds');
const OUT_DIR = join(ROOT, 'src', 'data');
const ASSET_OUT_ROOT = join(ROOT, 'public', 'entry-assets');
// The prefab table lives under public/ so it's served as a static asset for
// the browser-side Canvas viewer; this script reads the same single file.
const PREFAB_TABLE_PATH = join(ROOT, 'public', 'data', 'render-prefabs.json');

// Lazily loaded once at startup; null if the table isn't built yet, in which
// case floor-plan generation is skipped (the build still succeeds).
let prefabTable = null;

const log = (...a) => console.log('[build-index]', ...a);
const warn = (...a) => console.warn('[build-index] WARN:', ...a);

async function listBuildFolders() {
  if (!existsSync(BUILDS_DIR)) return [];
  const entries = await readdir(BUILDS_DIR, { withFileTypes: true });
  return entries.filter(e => e.isDirectory()).map(e => join(BUILDS_DIR, e.name));
}

async function readManifest(folder) {
  const slug = basename(folder);
  const manifestPath = join(folder, 'manifest.json');
  if (!existsSync(manifestPath)) {
    warn(`skipping ${slug}: no manifest.json`);
    return null;
  }
  try {
    const raw = await readFile(manifestPath, 'utf8');
    const data = JSON.parse(raw);
    if (data.id !== slug) {
      warn(`manifest id "${data.id}" does not match folder name "${slug}". Using folder name.`);
      data.id = slug;
    }
    return { folder, data };
  } catch (e) {
    warn(`could not parse ${manifestPath}: ${e.message}`);
    return null;
  }
}

async function copyAssetsFor(folder, manifest) {
  const outDir = join(ASSET_OUT_ROOT, manifest.id);
  // wipe then re-copy to avoid stale assets sticking around after a rename
  if (existsSync(outDir)) await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const filesToCopy = new Set();
  for (const s of manifest.screenshots ?? []) filesToCopy.add(s);
  if (manifest.schematicFile) filesToCopy.add(manifest.schematicFile);
  if (manifest.thumbnail) filesToCopy.add(manifest.thumbnail);

  for (const rel of filesToCopy) {
    const src = join(folder, rel);
    const dest = join(outDir, rel);
    if (!existsSync(src)) {
      warn(`missing asset for ${manifest.id}: ${rel}`);
      continue;
    }
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
  }

  // Parse the schematic once and derive everything we read from it
  // (floor plan, DLC packs, …) in a single pass. Failures are non-fatal:
  // a build with a text-placeholder schematic just skips derivation. The
  // derived fields are mutated onto the manifest so shapeForIndex can pick
  // them up without threading them through every call site.
  await processSchematic(folder, manifest, outDir);
}

/**
 * One read of the .schematic, multiple derivations.
 *
 * Mutates these fields onto `manifest`:
 *   __hasFloorplan   — boolean, did we successfully write floorplan.svg
 *   __derivedPacks   — string[] of DLC slugs from the schematic's prefabs
 *                      (unioned with manifest.dlc downstream in shapeForIndex)
 *   __storedItems    — { inventories, stacks } | null — non-empty container
 *                      contents shipped inside the schematic (null if none)
 *   __objectCount    — number | null — placed build pieces (null if no schematic)
 *   __placement      — 'territory-bound' | 'placeable' | null
 *   __schematicVersion — string | null — the file's format version
 *
 * The floor plan needs the prefab table; the other derivations don't, so we
 * still run them when the table is missing.
 */
async function processSchematic(folder, manifest, outDir) {
  manifest.__hasFloorplan = false;
  manifest.__derivedPacks = [];
  manifest.__storedItems = null;
  manifest.__objectCount = null;
  manifest.__placement = null;
  manifest.__schematicVersion = null;

  if (!manifest.schematicFile) return;
  const schematicPath = join(folder, manifest.schematicFile);
  if (!existsSync(schematicPath)) return;

  let schematic;
  try {
    const raw = await readFile(schematicPath, 'utf8');
    schematic = JSON.parse(raw);
  } catch (e) {
    warn(`${manifest.id}: schematic isn't valid JSON, skipping derivation (${e.message.slice(0, 80)})`);
    return;
  }
  if (!Array.isArray(schematic.entities)) {
    // Placeholder text files etc. — silently skip.
    return;
  }

  // Placement: a territory save records a `territoryIndex` and omits
  // location/boundingBox (KindredSchematics SchematicService.SaveSchematic);
  // radius/box saves do the opposite. territoryIndex can legitimately be 0,
  // so test the type, not truthiness.
  manifest.__placement = typeof schematic.territoryIndex === 'number'
    ? 'territory-bound'
    : 'placeable';
  // Format version the mod stamped into the file (currently always "1.0.1").
  if (typeof schematic.version === 'string') manifest.__schematicVersion = schematic.version;

  manifest.__objectCount = deriveObjectCount(schematic);
  if (manifest.objectCount != null && manifest.objectCount !== manifest.__objectCount) {
    log(`object count ${manifest.id}: derived ${manifest.__objectCount} (manifest said ${manifest.objectCount}; using derived)`);
  }

  manifest.__storedItems = deriveStoredItems(schematic);
  if (manifest.__storedItems) {
    const { inventories, stacks } = manifest.__storedItems;
    log(`stored items ${manifest.id}: ${stacks} stack(s) across ${inventories} inventor${inventories === 1 ? 'y' : 'ies'}`);
  }

  if (prefabTable) {
    manifest.__derivedPacks = derivePacks(schematic, prefabTable);
    manifest.__hasFloorplan = await writeFloorplan(schematic, manifest, outDir);
  }
}

/**
 * Walk the schematic's entities and collect the unique set of `pack` slugs
 * advertised by the prefab table. Returns an array sorted for stable output.
 */
function derivePacks(schematic, table) {
  const packs = new Set();
  for (const ent of schematic.entities) {
    const pack = ent.prefab && table.prefabs[ent.prefab]?.pack;
    if (pack) packs.add(pack);
  }
  return [...packs].sort();
}

/**
 * Count the placed build pieces in a schematic.
 *
 * "Object" here matches KindredSchematics' own definition of a schematic
 * building entity (SchematicService.cs): prefabs prefixed TM_ (tile models),
 * Chain_ (railings/chains), or BP_ (blueprints). The file also stores spawned
 * dependencies that aren't placed objects — `External_Inventory` /
 * `Refinementstation_Inventory*` backers, stored `Item_*`, `CHAR_*` servants —
 * which this filter excludes. So this is far below `entities.length`.
 */
function deriveObjectCount(schematic) {
  let n = 0;
  for (const ent of schematic.entities) {
    if (ent.prefab && /^(TM_|Chain_|BP_)/.test(ent.prefab)) n++;
  }
  return n;
}

/**
 * Detect container contents the builder left inside the schematic.
 *
 * V Rising stores inventory contents in an `InventoryBuffer` component — a
 * fixed-length slot list of `{ ItemType, Amount }`. Empty slots are
 * `{ ItemType: "", Amount: 0 }`, so a filled slot is simply `Amount > 0`.
 * (Chests back their slots with a separate `External_Inventory` entity;
 * refinement stations and servant coffins carry their own buffers. We don't
 * care which kind it is — any buffer with a filled slot counts.)
 *
 * Returns { inventories, stacks } when at least one slot is filled, else null:
 *   inventories — distinct buffers that hold ≥1 filled slot
 *   stacks      — total filled slots across them
 * Deliberately not summing Amount: stack sizes balloon into the hundreds of
 * thousands (fuel, ingredients) and aren't a useful "note" number.
 */
function deriveStoredItems(schematic) {
  let inventories = 0;
  let stacks = 0;
  for (const ent of schematic.entities) {
    for (const c of ent.componentData ?? []) {
      if (c.component !== 'InventoryBuffer' || !Array.isArray(c.data)) continue;
      const filled = c.data.reduce((n, row) => n + (row.Amount > 0 ? 1 : 0), 0);
      if (filled > 0) { inventories++; stacks += filled; }
    }
  }
  return stacks > 0 ? { inventories, stacks } : null;
}

async function writeFloorplan(schematic, manifest, outDir) {
  try {
    const { svg, stats } = renderFloorplan(schematic, prefabTable);
    const outPath = join(outDir, 'floorplan.svg');
    await writeFile(outPath, svg);
    log(
      `floorplan ${manifest.id}: ${stats.tilesW}x${stats.tilesD} tiles, ` +
      `${stats.placed} placed, ${stats.unknownPrefabs} unknown`
    );
    return true;
  } catch (e) {
    warn(`${manifest.id}: floor plan render failed: ${e.message}`);
    return false;
  }
}

function shapeForIndex(m) {
  // dlc = union(manifest.dlc, packs auto-detected from the schematic).
  // Manual entries are preserved on purpose: they cover things the schematic
  // can't reflect (design intent, equippables shown in screenshots, etc.).
  // The form will eventually drop this field per the NEXT-STAGE plan; until
  // then both inputs feed in.
  const dlc = [...new Set([...(m.dlc ?? []), ...(m.__derivedPacks ?? [])])].sort();
  return {
    id: m.id,
    title: m.title,
    summary: m.summary,
    author: m.author,
    category: m.category,
    tier: m.tier,
    footprint: m.footprint,
    modes: m.modes ?? [],
    dlc,
    themes: m.themes ?? [],
    // Derived from the schematic (placed build pieces) when available; the
    // manifest value is only a fallback for text-placeholder builds. 0 keeps
    // the field a number so the UI's .toLocaleString() never sees undefined.
    objectCount: m.__objectCount ?? m.objectCount ?? 0,
    gameVersion: m.gameVersion,
    modVersion: m.modVersion,
    // Derived from the schematic; manifest value is a fallback only.
    placement: m.__placement ?? m.placement ?? undefined,
    schematicVersion: m.__schematicVersion ?? m.schematicVersion ?? undefined,
    thumbnail: m.thumbnail ?? m.screenshots?.[0] ?? null,
    screenshots: m.screenshots ?? [],
    schematicFile: m.schematicFile,
    submittedAt: m.submittedAt,
    updatedAt: m.updatedAt,
    featured: !!m.featured,
    tags: m.tags ?? [],
    warnings: m.warnings ?? null,
    // Only present when the schematic ships non-empty containers; omitted
    // otherwise so the gallery can treat its absence as "nothing stored".
    storedItems: m.__storedItems ?? undefined,
    // Only advertise the floor plan when the build actually wrote one.
    floorplan: m.__hasFloorplan ? 'floorplan.svg' : undefined
  };
}

async function loadPrefabTable() {
  if (!existsSync(PREFAB_TABLE_PATH)) {
    warn(`no ${relative(ROOT, PREFAB_TABLE_PATH)} — floor plans will be skipped.`);
    warn('  run `pnpm run build-render-prefabs` to generate it from data/render-prefabs.raw.json.');
    return null;
  }
  try {
    return JSON.parse(await readFile(PREFAB_TABLE_PATH, 'utf8'));
  } catch (e) {
    warn(`could not load prefab table: ${e.message}`);
    return null;
  }
}

async function main() {
  log(`scanning ${relative(ROOT, BUILDS_DIR)}`);
  prefabTable = await loadPrefabTable();
  const folders = await listBuildFolders();
  if (folders.length === 0) {
    warn('no build folders found. Writing empty index.');
  }

  const manifests = (await Promise.all(folders.map(readManifest))).filter(Boolean);
  log(`found ${manifests.length} manifest(s)`);

  // Wipe and refresh asset output root.
  if (existsSync(ASSET_OUT_ROOT)) await rm(ASSET_OUT_ROOT, { recursive: true, force: true });
  await mkdir(ASSET_OUT_ROOT, { recursive: true });

  for (const { folder, data } of manifests) {
    await copyAssetsFor(folder, data);
  }

  const index = manifests
    .map(m => shapeForIndex(m.data))
    .sort((a, b) => (Date.parse(b.updatedAt ?? b.submittedAt) || 0) - (Date.parse(a.updatedAt ?? a.submittedAt) || 0));

  const searchIndex = index.map(e => ({
    id: e.id,
    title: e.title,
    summary: e.summary,
    author: e.author.name,
    tags: [...e.tags, ...e.themes]
  }));

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, 'gallery-index.json'), JSON.stringify(index, null, 2) + '\n');
  await writeFile(join(OUT_DIR, 'search-index.json'), JSON.stringify(searchIndex, null, 2) + '\n');

  log(`wrote ${relative(ROOT, join(OUT_DIR, 'gallery-index.json'))} (${index.length} entries)`);
  log(`wrote ${relative(ROOT, join(OUT_DIR, 'search-index.json'))}`);
  log(`copied assets to ${relative(ROOT, ASSET_OUT_ROOT)}`);
}

main().catch(err => {
  console.error('[build-index] failed:', err);
  process.exit(1);
});
