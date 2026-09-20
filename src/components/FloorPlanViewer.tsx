/** @jsxImportSource preact */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  buildPanel,
  computePanelLayout,
  detectFloors,
  detectGridPitch,
  detectStairRuns,
  FLOOR_HEIGHT_M,
  LAYER_ORDER,
  type CategoryLookup,
  type FloorBand,
  type PanelGeom,
  type PanelHit,
  type PanelLayout,
  type PanelResult,
  type PrefabCategory,
  type Schematic,
  type StairRun,
  type YFilter,
} from '../lib/floorplan';
import { hydrateViewModel, type ViewModel } from '../lib/view-model';
import {
  buildPalette,
  clampTransform,
  clientToCanvas,
  configureCanvasForLayout,
  drawPanel,
  FLOORPLAN_THEMES,
  DEFAULT_THEME_NAME,
  IDENTITY_TRANSFORM,
  MAX_ZOOM,
  MIN_ZOOM,
  type FloorPlanTheme,
  type Transform,
} from '../lib/floorplan-canvas';
import {
  buildIsoScene,
  computeIsoLayout,
  type IsoLayout,
  type IsoScene,
} from '../lib/isoplan';
import {
  configureCanvasForIso,
  drawIsoScene,
  hitTestIso,
  ISO_THEMES,
  DEFAULT_ISO_THEME,
} from '../lib/isoplan-canvas';

interface Props {
  /**
   * URL to the build's view.json — the slim render payload written at build
   * time by src/lib/view-model.mjs (served from /entry-assets/<slug>/).
   */
  viewModelUrl: string;
  /** Used for aria-label and the canvas's accessible name. */
  entryTitle: string;
}

interface LoadedData {
  schematic: Schematic;
  categories: PrefabCategory[];
  lookup: CategoryLookup;
  layout: PanelLayout;
  geom: PanelGeom;
  bands: FloorBand[];
  /** All stair flights, each tagged (below) with the floor it rises from. */
  stairRuns: StairRun[];
  /** Schematic Y origin — used to map a run's minY to a floor band index. */
  yMin: number;
}

/**
 * What the viewer is currently showing:
 *   - all:   merged view (no Y filter)
 *   - floor: one detected band, snapped (center-mode filter)
 */
type Selection =
  | { kind: 'all' }
  | { kind: 'floor'; index: number };

const ALL: Selection = { kind: 'all' };

/**
 * Which projection is on screen. Both read the same entities through the same
 * filter; they differ only in how a piece is drawn — a flat rect at its
 * footprint, or a box extruded to its collider height.
 */
type Mode = 'plan' | 'iso';

// Fallback grid spacing when a build has too few floor tiles to detect a
// pitch — 10 tiles is the common V Rising castle cell.
const FALLBACK_GRID_STEP = 10;

// Paint order → "on top" ranking for hover hit-testing (later = higher).
const LAYER_INDEX = new Map(LAYER_ORDER.map((id, i) => [id, i]));

// Turn a raw prefab name into something readable for the tooltip, e.g.
// "TM_Castle_Wall_Tier02_Stone" -> "Wall Tier02 Stone".
function humanizePrefab(name: string): string {
  return name
    .replace(/^(TM|BP)_/, '')
    .replace(/^Castle_/, '')
    .replace(/_/g, ' ')
    .trim();
}

function toYFilter(sel: Selection, bands: FloorBand[]): YFilter | null {
  if (sel.kind === 'all') return null;
  const b = bands[sel.index];
  return b ? { mode: 'center', y0: b.y0, y1: b.y1 } : null;
}

/**
 * FloorPlanViewer — interactive build viewer, rendered on Canvas.
 *
 * Two projections over one set of entities:
 *   - Plan: top-down, at the same scale as the static SVG renderer (shared via
 *     src/lib/floorplan.mjs), with a grid aligned to the placement pitch.
 *   - Isometric: the same pieces extruded to their collider heights
 *     (src/lib/isoplan.mjs), which reads as a massing model.
 * Floor buttons, layer toggles, pan/zoom and hover work the same in both.
 *
 * Renders as a Preact island with `client:only="preact"` from the entry
 * page; the page also emits a `<noscript><img/></noscript>` fallback.
 */
export default function FloorPlanViewer({
  viewModelUrl,
  entryTitle,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Refs the native pointer handler reads so it always sees current values
  // (the handler is attached once per load and would otherwise close over
  // stale transform/hidden/hits).
  const hitsRef = useRef<PanelHit[] | null>(null);
  const transformRef = useRef<Transform>(IDENTITY_TRANSFORM);
  const hiddenRef = useRef<Set<string>>(new Set());
  // The pointer handler is attached once per load, so mode-dependent values it
  // needs (which surface it's clamping against, what's under the cursor) come
  // through refs rather than the closure.
  const isoRef = useRef<IsoScene | null>(null);
  const isoLayoutRef = useRef<IsoLayout | null>(null);
  const surfaceRef = useRef<{ drawW: number; drawH: number }>({ drawW: 1, drawH: 1 });
  const [data, setData] = useState<LoadedData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('plan');
  const [selection, setSelection] = useState<Selection>(ALL);
  // Category ids the user has toggled off in the legend.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  // Pan/zoom. panX/panY are in unzoomed content px; zoom in [MIN,MAX].
  const [transform, setTransform] = useState<Transform>(IDENTITY_TRANSFORM);
  // Hover tooltip: position (relative to the canvas wrap) + text, or null.
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);

  const toggleLayer = (id: string) =>
    setHidden(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  // Fetch the view model on mount. One request, already classified: the
  // geometry passes below run on the hydrated entities exactly as they used
  // to run on the raw .schematic.
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    setSelection(ALL);
    setHidden(new Set());
    setTransform(IDENTITY_TRANSFORM);
    (async () => {
      try {
        const res = await fetch(viewModelUrl);
        if (!res.ok) throw new Error(`view model ${res.status}`);
        const vm = await res.json() as ViewModel;
        if (cancelled) return;

        const { schematic, lookup } = hydrateViewModel(vm);
        const layout = computePanelLayout(schematic);
        const pitch  = detectGridPitch(schematic.entities, lookup);
        const geom: PanelGeom = {
          minTX: layout.minTX, maxTZ: layout.maxTZ, cell: layout.cell, pitch,
        };
        const bands = detectFloors(schematic);
        const stairRuns = detectStairRuns(schematic.entities, lookup, pitch);
        const yMin = schematic.boundingBox?.min?.[1] ?? 0;

        setData({ schematic, categories: vm.categories, lookup, layout, geom, bands, stairRuns, yMin });
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [viewModelUrl]);

  const palette = useMemo(
    () => (data ? buildPalette(data.categories) : null),
    [data],
  );

  const theme = useMemo<FloorPlanTheme>(() => {
    const preset = FLOORPLAN_THEMES[DEFAULT_THEME_NAME];
    const gridStep = data?.geom.pitch || FALLBACK_GRID_STEP;
    return { ...preset, gridStep };
  }, [data]);

  // A staircase is a vertical connector spanning two floors, so it can't be
  // sliced by height like walls/floors without showing half-flights with no
  // context ("impossible stairs"). Instead we assign each whole run to the
  // floor it rises from — floorOf(run.minY) — and show the complete run there.
  // On the All view, every run shows.
  const floorRuns: StairRun[] = useMemo(() => {
    if (!data) return [];
    if (selection.kind === 'all') return data.stairRuns;
    const floorOf = (y: number) =>
      Math.min(
        data.bands.length - 1,
        Math.max(0, Math.floor((y - data.yMin) / FLOOR_HEIGHT_M)),
      );
    return data.stairRuns.filter(r => floorOf(r.minY) === selection.index);
  }, [data, selection]);

  // Stair cells for the current selection — shared by both renderers so a
  // whole flight lands on its origin floor either way.
  const stairCells = useMemo(
    () => (selection.kind === 'all'
      ? undefined
      : new Set(floorRuns.flatMap(r => r.cells.map(c => `${c.x},${c.z}`)))),
    [selection, floorRuns],
  );

  // Bucket entities for the current selection. Non-stair categories slice by
  // height band; stairs are shown by run-assignment via stairCells so whole
  // flights land on their origin floor. buildPanel is a single pass — cheap
  // enough to redo on every button press.
  const panel: PanelResult | null = useMemo(() => {
    if (!data || mode !== 'plan') return null;
    return buildPanel(
      data.schematic.entities, data.lookup, data.geom,
      toYFilter(selection, data.bands),
      { stairCells, collectHits: true },
    );
  }, [data, mode, selection, stairCells]);

  // Same entities, same filter, extruded instead of flattened.
  const iso: IsoScene | null = useMemo(() => {
    if (!data || mode !== 'iso') return null;
    return buildIsoScene(
      data.schematic.entities, data.lookup, data.geom,
      toYFilter(selection, data.bands),
      { stairCells },
    );
  }, [data, mode, selection, stairCells]);

  const isoLayout = useMemo(
    () => (iso ? computeIsoLayout(iso, { targetWidth: 800, maxCell: 6 }) : null),
    [iso],
  );

  // Arrows come from the same runs as the fill, so they always sit on stairs.
  const stairRuns = floorRuns;

  // The surface the transform is clamped against, per mode.
  const surface = mode === 'iso'
    ? (isoLayout ?? { drawW: 1, drawH: 1 })
    : (data?.layout ?? { drawW: 1, drawH: 1 });

  // Keep refs current for the native pointer handler (attached once per load).
  hitsRef.current = panel?.hits ?? null;
  isoRef.current = iso;
  isoLayoutRef.current = isoLayout;
  surfaceRef.current = { drawW: surface.drawW, drawH: surface.drawH };
  transformRef.current = transform;
  hiddenRef.current = hidden;

  // Size the canvas whenever the drawn surface changes. In plan mode that's
  // once per load (the layout is selection-independent); in iso mode the
  // extent depends on what's visible, so it follows the scene.
  useEffect(() => {
    if (!canvasRef.current) return;
    if (mode === 'iso') {
      if (isoLayout) configureCanvasForIso(canvasRef.current, isoLayout);
    } else if (data) {
      configureCanvasForLayout(canvasRef.current, data.layout);
    }
  }, [data, mode, isoLayout]);

  // Switching projection changes the coordinate space, so a pan/zoom carried
  // over would land somewhere arbitrary. Start each mode at fit.
  useEffect(() => { setTransform(IDENTITY_TRANSFORM); }, [mode]);

  // Repaint whenever the scene, theme, hidden set, or transform changes. Only
  // the draw call re-runs on pan/zoom — the buckets and boxes are memoized and
  // unaffected — so dragging stays cheap.
  useEffect(() => {
    if (!data || !palette || !canvasRef.current) return;
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;
    if (mode === 'iso') {
      if (!iso || !isoLayout) return;
      drawIsoScene(ctx, iso, isoLayout, palette, ISO_THEMES[DEFAULT_ISO_THEME], {
        hiddenLayers: hidden,
        transform,
      });
    } else {
      if (!panel) return;
      drawPanel(ctx, panel, data.layout, palette, theme, {
        hiddenLayers: hidden,
        stairRuns,
        transform,
      });
    }
  }, [mode, panel, iso, isoLayout, data, palette, theme, hidden, stairRuns, transform]);

  // Pan/zoom: wheel zooms toward the cursor, one-pointer drag pans, two-pointer
  // pinch zooms + pans. Native listeners (not Preact props) so wheel can
  // preventDefault (passive:false) and pointer capture works during drags.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data) return;
    // Read through the ref: the drawn surface changes with the mode (and, in
    // iso, with the selection), while this handler is attached once.
    const surf = () => surfaceRef.current;
    const pointers = new Map<number, { x: number; y: number }>();
    let lastDist: number | null = null;
    let lastMid: { x: number; y: number } | null = null;

    const at = (e: PointerEvent | WheelEvent) =>
      clientToCanvas(canvas, e.clientX, e.clientY);

    // Hover hit-test: map the cursor to content coords, find the topmost
    // visible piece under it, and show its prefab name. In plan mode "topmost"
    // is the highest paint layer whose rect contains the point; in iso it's
    // the last box painted there, which hitTestIso resolves by walking the
    // scene front to back.
    const updateHover = (e: PointerEvent) => {
      const t = transformRef.current;
      const hiddenSet = hiddenRef.current;
      const s = at(e);
      const px = s.x / t.zoom + t.panX;
      const py = s.y / t.zoom + t.panY;

      let prefab: string | null = null;
      const isoScene = isoRef.current;
      const isoLay = isoLayoutRef.current;
      if (isoScene && isoLay) {
        prefab = hitTestIso(isoScene, isoLay, px, py, hiddenSet)?.prefab ?? null;
      } else {
        const hits = hitsRef.current;
        if (!hits || !hits.length) { setHover(null); return; }
        let best: PanelHit | null = null;
        let bestRank = -1;
        for (const h of hits) {
          if (hiddenSet.has(h.layerId)) continue;
          if (px >= h.x && px <= h.x + h.w && py >= h.y && py <= h.y + h.h) {
            const rank = LAYER_INDEX.get(h.layerId) ?? -1;
            if (rank >= bestRank) { bestRank = rank; best = h; }
          }
        }
        prefab = best?.prefab ?? null;
      }

      if (!prefab) { setHover(null); return; }
      const wrap = canvas.parentElement;
      const rect = (wrap ?? canvas).getBoundingClientRect();
      setHover({ x: e.clientX - rect.left, y: e.clientY - rect.top, text: humanizePrefab(prefab) });
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const c = at(e);
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      setTransform(t => {
        const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, t.zoom * factor));
        // Keep the content point under the cursor fixed.
        const px = c.x / t.zoom + t.panX;
        const py = c.y / t.zoom + t.panY;
        return clampTransform(
          { zoom, panX: px - c.x / zoom, panY: py - c.y / zoom },
          surf().drawW, surf().drawH,
        );
      });
    };

    const onPointerDown = (e: PointerEvent) => {
      try { canvas.setPointerCapture(e.pointerId); } catch { /* stray/synthetic id */ }
      pointers.set(e.pointerId, at(e));
      lastDist = null;
      lastMid = null;
      canvas.style.cursor = 'grabbing';
      setHover(null); // hide tooltip while dragging
    };

    const onPointerMove = (e: PointerEvent) => {
      // No active drag → treat as hover.
      if (pointers.size === 0) { updateHover(e); return; }
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId)!;
      const cur = at(e);
      pointers.set(e.pointerId, cur);

      if (pointers.size === 1) {
        const dx = cur.x - prev.x;
        const dy = cur.y - prev.y;
        setTransform(t => clampTransform(
          { zoom: t.zoom, panX: t.panX - dx / t.zoom, panY: t.panY - dy / t.zoom },
          surf().drawW, surf().drawH,
        ));
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (lastDist != null && lastMid != null) {
          const factor = dist / lastDist;
          const dmx = mid.x - lastMid.x;
          const dmy = mid.y - lastMid.y;
          setTransform(t => {
            const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, t.zoom * factor));
            const px = mid.x / t.zoom + t.panX;
            const py = mid.y / t.zoom + t.panY;
            return clampTransform(
              { zoom, panX: px - mid.x / zoom - dmx / zoom, panY: py - mid.y / zoom - dmy / zoom },
              surf().drawW, surf().drawH,
            );
          });
        }
        lastDist = dist;
        lastMid = mid;
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) { lastDist = null; lastMid = null; }
      if (pointers.size === 0) canvas.style.cursor = 'grab';
    };

    const onDblClick = () => setTransform(IDENTITY_TRANSFORM);
    const onPointerLeave = () => setHover(null);

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('dblclick', onDblClick);
    canvas.style.cursor = 'grab';
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('dblclick', onDblClick);
    };
  }, [data]);

  // Legend rows: one per non-empty category in the *current* view, most
  // common first (mirrors the SVG legend's ordering).
  const legend = useMemo(() => {
    const counts = mode === 'iso' ? iso?.counts : panel?.counts;
    if (!data || !counts) return null;
    const byId = new Map(data.categories.map(c => [c.id, c]));
    const rows: { id: string; label: string; color: string; count: number }[] = [];
    for (const [id, count] of counts.entries()) {
      if (!count) continue;
      const meta = byId.get(id);
      if (meta) rows.push({ id, label: meta.label, color: meta.color, count });
    }
    rows.sort((a, b) => b.count - a.count);
    return rows;
  }, [data, mode, panel, iso]);

  if (error) {
    return (
      <div class="fpv fpv--error" role="alert">
        <p>Couldn’t load this build: {error}.</p>
      </div>
    );
  }

  const scene = mode === 'iso' ? iso : panel;
  if (!data || !scene) {
    return (
      <div class="fpv fpv--loading" aria-live="polite">
        <p class="muted">Loading floor plan…</p>
      </div>
    );
  }

  const hasFloors = data.bands.length > 0;
  // Up-arrows are a plan-view symbol; in iso the flights read as ramps.
  const hasStairArrows =
    mode === 'plan' && stairRuns.some(r => r.path) && !hidden.has('stairs');
  const viewLabel =
    selection.kind === 'all' ? 'All floors' : data.bands[selection.index].label;

  // Zoom button: scale around the viewport center, clamped to bounds.
  const zoomBy = (factor: number) => setTransform(t => {
    const { drawW, drawH } = surface;
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, t.zoom * factor));
    const cx = t.panX + drawW / t.zoom / 2;
    const cy = t.panY + drawH / t.zoom / 2;
    return clampTransform(
      { zoom, panX: cx - drawW / zoom / 2, panY: cy - drawH / zoom / 2 },
      drawW, drawH,
    );
  });
  const resetView = () => setTransform(IDENTITY_TRANSFORM);
  const zoomedIn = transform.zoom > MIN_ZOOM + 1e-3;

  return (
    <div class="fpv">
      <div class="fpv__head">
        <span class="fpv__title">{viewLabel}</span>
        <span class="fpv__sub muted">{scene.placed} entities</span>
      </div>

      <div class="fpv__controls">
        <div class="fpv__modes" role="group" aria-label="View">
          {(['plan', 'iso'] as Mode[]).map(m => (
            <button
              type="button"
              key={m}
              class={`fpv__mode-btn${mode === m ? ' is-active' : ''}`}
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
            >
              {m === 'plan' ? 'Plan' : 'Isometric'}
            </button>
          ))}
        </div>

        {hasFloors && (
          <div class="fpv__floors" role="group" aria-label="Floor">
            <button
              type="button"
              class={`fpv__floor-btn${selection.kind === 'all' ? ' is-active' : ''}`}
              aria-pressed={selection.kind === 'all'}
              onClick={() => setSelection(ALL)}
            >
              All
            </button>
            {data.bands.map((b, i) => (
              <button
                type="button"
                key={b.floorIndex}
                class={`fpv__floor-btn${selection.kind === 'floor' && selection.index === i ? ' is-active' : ''}`}
                aria-pressed={selection.kind === 'floor' && selection.index === i}
                title={b.yRangeStr}
                onClick={() => setSelection({ kind: 'floor', index: i })}
              >
                {b.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div class="fpv__canvas-wrap">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={mode === 'iso'
            ? `Isometric view of ${entryTitle}`
            : `Top-down floor plan of ${entryTitle}`}
        />
        <div class="fpv__zoom" role="group" aria-label="Zoom">
          <button type="button" class="fpv__zoom-btn" aria-label="Zoom in" onClick={() => zoomBy(1.4)}>+</button>
          <button
            type="button"
            class="fpv__zoom-btn"
            aria-label="Reset view"
            title="Reset view"
            disabled={!zoomedIn}
            onClick={resetView}
          >⤢</button>
          <button type="button" class="fpv__zoom-btn" aria-label="Zoom out" disabled={!zoomedIn} onClick={() => zoomBy(1 / 1.4)}>−</button>
        </div>
        {hover && (
          <div
            class="fpv__tooltip"
            style={`left:${hover.x}px; top:${hover.y}px`}
            aria-hidden="true"
          >
            {hover.text}
          </div>
        )}
      </div>

      <ul class="fpv__legend" aria-label="Floor plan layers — click to toggle">
        {legend?.map(row => {
          const isHidden = hidden.has(row.id);
          return (
            <li key={row.id}>
              <button
                type="button"
                class={`fpv__legend-item${isHidden ? ' is-hidden' : ''}`}
                aria-pressed={!isHidden}
                title={isHidden ? `Show ${row.label}` : `Hide ${row.label}`}
                onClick={() => toggleLayer(row.id)}
              >
                <span class="fpv__swatch" style={`background:${row.color}`} aria-hidden="true" />
                <span class="fpv__legend-label">{row.label}</span>
                <span class="fpv__legend-count muted">{row.count}</span>
              </button>
            </li>
          );
        })}
      </ul>

      {hasStairArrows && (
        <p class="fpv__note muted">
          <span class="fpv__note-arrow" aria-hidden="true">↑</span>
          Arrows on stairs point up the flight.
        </p>
      )}
    </div>
  );
}
