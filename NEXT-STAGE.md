# Next stage: Option C — interactive floor plan viewer

This is a handoff. The static-SVG renderer (Options A + B) is shipped:
merged top-down view + per-floor slices, auto-derived from each schematic's
Y range. Option C lifts that into a browser-side interactive viewer.

## What "C" delivers

A Preact island that replaces the static `<img src="floorplan.svg">` on
the entry detail page with an interactive Canvas viewer:

- **Pan / zoom** (mouse drag + wheel; pinch on touch).
- **Y-slider** that picks a slice height continuously, not just at 5 m
  bands. Drag from `bbMin.y` to `bbMax.y`; entities filter live.
- **Layer toggles** — checkbox per category in the legend; click to show/hide
  walls, floors, plants, etc.
- **Tooltip on hover** showing the prefab name (we already have it in the
  slim table).

Pan/zoom + the slider are the headline. Layer toggles + tooltips are
nice-to-haves once the core works.

## Why it's small now

The hard parts are already done:

- **`scripts/render-floorplan.mjs`** already splits orchestration from
  per-panel rendering. The inner `buildPanel(entities, lookup, geom, yFilter)`
  is the function to port — it walks entities, applies rotation, dedupes,
  buckets by category. The Canvas viewer calls this with `yFilter` set to
  a movable `{y0, y1}` window from the slider.
- **`src/data/render-prefabs.json`** (340 KB, gzips small) already carries
  everything the browser needs: `category`, `w`, `d`, `y0`, `y1` per
  prefab. Ship as-is. Loadable via `fetch('/schematic-archive/data/...')`
  *if* moved into `public/`; currently it lives in `src/data/` and is
  consumed at build time only — see "Shipping the data" below.
- **Per-entry schematics** are already copied to
  `public/entry-assets/<slug>/<file>.kindredschematic`. The viewer fetches
  the entity list from there.
- **Categories + colors** are in the slim table's `categories` array.

## Concrete starting points

1. **New file**: `src/components/FloorPlanViewer.tsx` (Preact island).
   - Props: `{ schematicUrl: string; prefabTableUrl: string; entryTitle: string }`.
   - Fetches both URLs, renders a single `<canvas>` plus controls.
   - Reuses category color from the table.

2. **Port `buildPanel`** into a `drawPanel(ctx, entities, lookup, geom, yFilter)`
   in a shared `src/lib/floorplan.ts`. Replace SVG rect emission with
   `ctx.fillRect`. Same layer order, same dedupe, same rotation rule
   (`swapsWidthDepth`). Also export `detectFloors` so the slider can
   snap-to-floor on shift-drag.

3. **Edit `src/pages/entry/[slug].astro`**: when `entry.floorplan` is
   present and the schematic file is also web-accessible, render
   `<FloorPlanViewer client:visible schematicUrl=... prefabTableUrl=.../>`
   instead of `<img src={floorplanHref}>`. Keep the `<img>` as a
   `<noscript>` fallback so static OG / Save-for-later still works.

4. **Wire the prefab table to `public/`**: simplest is to teach
   `build-render-prefabs.mjs` to also write a copy to
   `public/data/render-prefabs.json` (gitignored — already covered by
   the existing rule).

5. **Astro config** — Preact is already set up (`@astrojs/preact` and
   one `GalleryBrowser.tsx` island already ship); no integration work.

## Files / lines as starting anchors

- `scripts/render-floorplan.mjs` — `buildPanel` is the function to lift.
- `src/pages/entry/[slug].astro` — `entry__floorplan` section is the
  swap-in point.
- `src/components/GalleryBrowser.tsx` — existing Preact island, mirror
  its shape for the new viewer.
- `src/data/render-prefabs.json` — schema v4 (`w`, `d`, `y0`, `y1` per
  prefab). Documented at the top of `scripts/build-render-prefabs.mjs`.
- `builds/<slug>/<slug>.kindredschematic` — example real schematics
  already in place (arena_75, base_24, castle_86 swapped into
  frostbound-keep, humble-outpost, emerald-garden respectively).

## Gotchas

- **Schematic format quirks**: `entity.tilePos` is `[tileX, tileZ]`
  (X/Z), `entity.pos` is `[worldX, worldY, worldZ]`. `boundingBox.min/max`
  is `[tileX, worldY, tileZ]` (mixed). `entity.rot` is **Euler degrees**,
  not a quaternion — see comment in `render-floorplan.mjs`.
- **1 tile = 1 m** in this grid; the AABB in `render-prefabs.json` is in
  meters and translates directly to tile units.
- **Center-Y band semantics**: `detectFloors` + center-Y test produces
  clean per-floor partitions (each entity in exactly one band). For a
  continuous Y-slider, you'll want overlap semantics instead so dragging
  the slider 0.1 m doesn't snap entities in/out — see comment in
  `buildPanel` for the previous overlap rule we walked away from.
- **Coordinate flip**: SVG had north-up via `(maxTZ - tilePos[1])`.
  Canvas works the same way; keep the mirror.

## Suggested order for the next session

1. Port `buildPanel` / `detectFloors` into `src/lib/floorplan.ts` (no
   behavioral change yet).
2. Refit the SVG renderer in `render-floorplan.mjs` to import from
   `src/lib/floorplan.ts` — proves the lift didn't break the static
   pipeline.
3. Write the Preact `FloorPlanViewer` against Canvas, no controls yet.
   Verify it draws an equivalent image to the static SVG.
4. Add pan / zoom (wheel + drag).
5. Add the Y-slider with continuous slicing.
6. Layer toggles + hover tooltips.
7. Hook into the entry page; keep `<img>` as `<noscript>` fallback.

If short on time, stop after step 3 — that's still a meaningful upgrade
over the static SVG because users can zoom into the merged view.

## Status snapshot at handoff

- `scripts/build-render-prefabs.mjs` schema v4 (with AABB + Y bounds).
- `scripts/render-floorplan.mjs` produces merged + sliced panels.
- `scripts/build-index.mjs` auto-renders floor plans on build.
- All three demo entries (frostbound-keep, humble-outpost, emerald-garden)
  carry real schematics and render correctly — verified in browser at
  desktop and mobile viewport.
- Mod side (KindredExtract) has `.dump renderprefabs` emitting raw AABB
  data; no further mod changes needed for C.
- One pre-existing finding: page-level horizontal overflow on mobile
  (~112 px), upstream of any floor plan work. Worth a separate fix.
