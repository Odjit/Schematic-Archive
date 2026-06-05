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
  - **`objectCount` — DONE**: `deriveObjectCount` in `build-index.mjs` counts
    placed build pieces = prefabs prefixed `TM_`/`Chain_`/`BP_` (the mod's own
    schematic-object definition, `SchematicService.cs:472`), excluding spawned
    dependencies (`External_Inventory`/`Refinementstation_Inventory*` backers,
    stored `Item_*`, `CHAR_*` servants). NOT `entities.length` — that includes
    those dependencies. Dropped from the submit form; schema field now optional
    (fallback for text-placeholder builds only). **Note:** the old sample
    manifests' `objectCount` values (814/1432/248) were fabricated placeholders
    — KindredSchematics shows no count on save, so there was never an in-game
    number to match; derived counts are 2744/2221/1805.
  - **`footprint` — STAYS MANUAL** (maintainer decision): the sample labels
    track build size, not `boundingBox` (emerald's bbox 254×204 > frostbound's
    214×204, yet emerald=medium and frostbound=large). It's an author judgment;
    no clean geometry rule. Left as a form field.
  - **`version` — DONE**: surfaced as `schematicVersion` from the file's
    top-level `version` (`SchematicService` stamps `"1.0.1"`). This is the
    *schematic format* version — distinct from `gameVersion` (1.0/1.1) and
    `modVersion`. Optional/derived in schema; shown as "Schematic format" in
    MetaPanel. (All current files are `1.0.1`; this future-proofs a format bump.)
    **The two form version fields were removed** (maintainer call): the V Rising
    game version isn't in the schematic, so `gameVersion` could never be derived
    — it's dropped from the form, the gallery filter rail, and the detail page
    (schema field kept optional/legacy so old manifests validate). `modVersion`
    also left the form; it's optional now and shown only when a maintainer sets
    it. The schematic format version is the only version surfaced.
  - **`placement` — DONE** (derive + display): `territory-bound` when the file
    has a numeric `territoryIndex` (a `saveterritory`, no boundingBox/location —
    confirmed against `SchematicService.SaveSchematic`), else `placeable`.
    `PLACEMENTS` vocab in `site-config.ts`, optional enum in schema, shown in
    MetaPanel with a hint. `territoryIndex` can be 0, so the check is `typeof
    === 'number'`, not truthiness. **Not yet a filter facet**: all in-repo
    samples are `placeable`, so a rail filter has nothing to discriminate — defer
    the filter UI to the Type/Modular-Room taxonomy pass (which adds its own
    facets). No territory-bound sample exists in-repo to eyeball the UI against.
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
- **Slim the submit form — LARGELY DONE**: now human-only fields — title,
  summary, author (single name field), category, tier, footprint, modes,
  themes, schematic file, screenshots, notes. Dropped: DLC, object count,
  game/mod version, and the Discord/GitHub author fields. `manifest.schema.json`
  has the derived fields optional. Still TODO for the taxonomy pass: add the
  `type` enum + Modular Room category set, and the placement filter facet.
- All schematic-derived fields are now live: DLC packs, objectCount,
  stored-items, placement, schematicVersion — all from the single
  `processSchematic` pass in `scripts/build-index.mjs`. The submit form is
  slimmed (DLC, object-count, game/mod version, and the two author contact
  fields dropped).
  What's left is the **taxonomy redesign**: top-level Type (Build vs Modular
  Room) with per-Type category sets, and turning `placement` into a filter
  facet once there's territory-bound data to filter.
