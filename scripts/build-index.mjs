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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const BUILDS_DIR = join(ROOT, 'builds');
const OUT_DIR = join(ROOT, 'src', 'data');
const ASSET_OUT_ROOT = join(ROOT, 'public', 'entry-assets');

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
}

function shapeForIndex(m) {
  return {
    id: m.id,
    title: m.title,
    summary: m.summary,
    author: m.author,
    category: m.category,
    tier: m.tier,
    footprint: m.footprint,
    modes: m.modes ?? [],
    dlc: m.dlc ?? [],
    themes: m.themes ?? [],
    objectCount: m.objectCount,
    gameVersion: m.gameVersion,
    modVersion: m.modVersion,
    thumbnail: m.thumbnail ?? m.screenshots?.[0] ?? null,
    screenshots: m.screenshots ?? [],
    schematicFile: m.schematicFile,
    submittedAt: m.submittedAt,
    updatedAt: m.updatedAt,
    featured: !!m.featured,
    tags: m.tags ?? [],
    warnings: m.warnings ?? null
  };
}

async function main() {
  log(`scanning ${relative(ROOT, BUILDS_DIR)}`);
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
