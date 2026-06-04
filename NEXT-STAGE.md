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
  - DLC packs: classifier on prefab name tokens (confirmed present in the build
    prefabs). Mapping: `Bloodline`→eldest-bloodline, `Relic`/`Draculas`→
    draculas-relics, `Halloween`→haunted-nights, `Gloomrot`→sinister-evolution,
    `ProjectK`→castlevania, `Blackfang`→eternal-dominance. Emit a `pack` per
    prefab in build-render-prefabs; build-index unions packs across an entry's
    entities. (Reference dump: C:\Repositories\Info\Info\EntityStateFiles.)
- **Slim the submit form** to human-only fields: type, title, summary, author,
  category, themes, modes, schematic file, screenshots, notes. Everything above
  is derived. Update `manifest.schema.json` (make derived fields optional; add
  `type` + `placement` enums) and `site-config.ts` (add the Modular Room
  category set + the placement facet).
- Research done — territory rule and DLC tokens both confirmed; what's left is
  the implementation (build-index extraction, schema, site-config, slim form).
