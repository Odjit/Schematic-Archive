# Schematic Archive — status & next steps

Community gallery of V Rising builds for the KindredSchematics mod. Astro +
Preact, deploys to GitHub Pages.

## Shipped
- Static top-down floor-plan SVGs (build time) **and** an interactive Canvas
  viewer on entry pages, both from one shared renderer.
- Viewer: floor buttons, layer toggles, pan/zoom (wheel/drag/pinch + on-screen
  controls), hover tooltips.
- Rendering: grid-pitch floor fill, contiguous stairs with up-arrows on their
  origin floor, slim doors, shape-aware grid-snapped pavement/carpet ribbons,
  Servant/NPC classification (0 unknown prefabs).
- `npm test` (node:test over the pure lib). Mobile horizontal-overflow fixed.

## Key files
- `src/lib/floorplan.mjs` (+ `.d.ts`) — shared geometry: `buildPanel`,
  `detectFloors`/`detectGridPitch`/`detectStairRuns`, `ribbonArms`.
- `src/lib/floorplan-canvas.ts` — Canvas paint: `drawPanel`, themes, transform.
- `src/components/FloorPlanViewer.tsx` (+ `floor-plan-viewer.css`) — the island.
- `scripts/render-floorplan.mjs` — build-time SVG (the `<noscript>` fallback).
- `scripts/build-render-prefabs.mjs` — prefab classifier → `public/data/`.
- `tests/floorplan.test.mjs`.

## Deploy
- Push to `main` → `.github/workflows/deploy.yml` builds and publishes to Pages.
- Repo Settings → Pages → Source must be **GitHub Actions**.
- `base` is `/Schematic-Archive` — must match the repo name (Pages is
  case-sensitive). Local build uses `pnpm run build`.

## Next steps (unordered)
- **Submissions flow**: document adding a build under `builds/<slug>/`;
  `validate-pr.yml` already gates `builds/**` on PRs. Maybe a PR template.
- **SVG fallback parity**: per-floor SVG slices still cut stairs by height;
  could reuse the viewer's whole-flight logic.
- **Per-entry OG images** (see `OG_IMAGE_TODO` in `deploy.yml`).
- **Carpets** are untested on real data (no demo build has them) — add one.
- Pavement doesn't bridge openings wider than ~2 cells; revisit if it shows up.
- Entry page: real README/related-entries (currently summary placeholder).

## Planned: taxonomy + form redesign (maintainer-directed)
- **Top-level Type**: Build vs Modular Room (for the Catacombs mod — small rooms
  the mod assembles into dungeons). Each Type gets its own category set; rooms
  may later carry connector/exit metadata.
- **Auto-derive at build time from the `.schematic`** (and drop from the form):
  - `objectCount` = `entities.length`
  - `footprint` = from `boundingBox` size
  - `version` = file's top-level `version` (e.g. `"1.0.1"`)
  - `placement`: **territory-bound** if the file has `territoryIndex` (these
    have no `boundingBox`/`location`) — confirmed against a sample; otherwise
    **placeable**. Coord-locked-vs-anywhere is a softer call, TBD.
  - **DLC packs — DONE** (schemaVersion 5): maintainer pasted the game's
    authoritative `DlcTileModelsByContentFlag` table verbatim (186 prefab
    names across 6 packs); embedded as `DLC_TILE_MODELS` in
    `scripts/build-render-prefabs.mjs`. Each prefab now carries a `pack`
    slug (one of the `DLCS` slugs in `src/site-config.ts`).
    `scripts/build-index.mjs` walks each schematic's entities, unions
    detected packs, and merges with `manifest.dlc` (manual entries kept —
    they cover design intent and equippables that aren't placed entities).
    Build coverage: all 186 listed names resolved in the current dump.
    Equippables (`dlcBoundItems` in the maintainer's paste) and the items-
    only `GiveAway_Razer01` pack are out of scope — schematics record
    placed castle props, not what the player is wearing.
    **Footgun for refreshes**: C# `Prefabs.*` constants substitute `_` for
    `-` in carpet `Cross-Section`/`T-Section` names. Anything verbatim-
    pasted from the C# constants table needs the underscore→hyphen swap;
    a guarded loop in build-render-prefabs already warns on any missing
    name when the dump is refreshed.
  - **Stored-items note — DONE**: `deriveStoredItems` in
    `scripts/build-index.mjs` scans each entity's `InventoryBuffer`
    component (chests back theirs on a separate `External_Inventory`
    entity; refineries/servant coffins carry their own). A filled slot is
    `Amount > 0` — empty slots are `{ ItemType: "", Amount: 0 }`. Emits
    `storedItems: { inventories, stacks }` on the gallery index only when
    something is stored (omitted otherwise), typed in `src/lib/filters.ts`,
    surfaced as a "Ships with stored items" callout on the entry page.
    Confirmed against the sample set: humble-outpost has 117 *empty*
    inventories → no note; emerald-garden has 29 filled → note. Not summing
    `Amount` on purpose (fuel/ingredient stacks balloon to 100k+ and aren't
    a useful headline number). Could become a filter facet later.
- **Slim the submit form** to human-only fields: type, title, summary, author,
  category, themes, modes, schematic file, screenshots, notes. Everything above
  is derived. Update `manifest.schema.json` (make derived fields optional; add
  `type` + `placement` enums) and `site-config.ts` (add the Modular Room
  category set + the placement facet).
- Research done — territory rule and DLC tokens both confirmed; DLC
  derivation is live. What's left for the form redesign: `objectCount`,
  `footprint`, `version`, `placement` derivation (one more pass over the
  parsed schematic — slot into the existing `processSchematic` in
  `scripts/build-index.mjs`), then schema + site-config + slim form.
