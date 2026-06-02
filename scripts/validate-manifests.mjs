#!/usr/bin/env node
/**
 * validate-manifests.mjs
 *
 * Validates every builds/<slug>/manifest.json against schemas/manifest.schema.json.
 * Also checks that referenced screenshot and schematic files actually exist.
 *
 * Exit code 0 if all pass, 1 if any fail. Designed for CI on PRs.
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const BUILDS_DIR = join(ROOT, 'builds');
const SCHEMA_PATH = join(ROOT, 'schemas', 'manifest.schema.json');

const RED = '\x1b[31m';
const YEL = '\x1b[33m';
const GRN = '\x1b[32m';
const DIM = '\x1b[2m';
const RST = '\x1b[0m';

async function main() {
  const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  const entries = await readdir(BUILDS_DIR, { withFileTypes: true });
  const folders = entries.filter(e => e.isDirectory()).map(e => e.name);

  let failed = 0;

  for (const slug of folders) {
    const folder = join(BUILDS_DIR, slug);
    const manifestPath = join(folder, 'manifest.json');
    if (!existsSync(manifestPath)) {
      console.error(`${RED}✗${RST} ${slug}: missing manifest.json`);
      failed++;
      continue;
    }
    let data;
    try {
      data = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch (e) {
      console.error(`${RED}✗${RST} ${slug}: invalid JSON (${e.message})`);
      failed++;
      continue;
    }

    if (data.id !== slug) {
      console.error(`${RED}✗${RST} ${slug}: id "${data.id}" does not match folder name`);
      failed++;
      continue;
    }

    const ok = validate(data);
    if (!ok) {
      console.error(`${RED}✗${RST} ${slug}: schema validation failed`);
      for (const err of validate.errors ?? []) {
        console.error(`    ${YEL}${err.instancePath || '/'}${RST} ${err.message}`);
      }
      failed++;
      continue;
    }

    const missing = [];
    for (const rel of data.screenshots ?? []) {
      if (!existsSync(join(folder, rel))) missing.push(rel);
    }
    if (data.schematicFile && !existsSync(join(folder, data.schematicFile))) {
      missing.push(data.schematicFile);
    }
    if (data.thumbnail && !existsSync(join(folder, data.thumbnail))) {
      missing.push(data.thumbnail);
    }
    if (missing.length) {
      console.error(`${RED}✗${RST} ${slug}: referenced files not found:`);
      missing.forEach(m => console.error(`    ${m}`));
      failed++;
      continue;
    }

    console.log(`${GRN}✓${RST} ${slug} ${DIM}${data.title}${RST}`);
  }

  console.log();
  if (failed > 0) {
    console.error(`${RED}${failed} manifest(s) failed validation.${RST}`);
    process.exit(1);
  } else {
    console.log(`${GRN}All ${folders.length} manifest(s) valid.${RST}`);
  }
}

main().catch(e => {
  console.error('Validator crashed:', e);
  process.exit(1);
});
