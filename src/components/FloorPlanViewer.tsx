/** @jsxImportSource preact */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  buildCategoryLookup,
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
  type PrefabTable,
  type Schematic,
  type StairRun,
  type YFilter,
} from '../lib/floorplan';
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

interface Props {
  /** URL to the .kindredschematic JSON file (served from /entry-assets/<slug>/). */
  schematicUrl: string;
  /** URL to render-prefabs.json (served once from /data/). */
  prefabTableUrl: string;
  /** Used for aria-label and the canvas's accessible name. */
  entryTitle: string;
}

interface LoadedData {
  schematic: Schematic;
  table: PrefabTable;
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
 * FloorPlanViewer — interactive top-down floor plan, rendered on Canvas.
 *
 * Draws the merged view at the same scale as the static SVG renderer (shared
 * via src/lib/floorplan.mjs), with discrete per-floor buttons and a grid
 * aligned to the building's placement pitch.
 *
 * Renders as a Preact island with `client:only="preact"` from the entry
 * page; the page also emits a `<noscript><img/></noscript>` fallback.
 */
export default function FloorPlanViewer({
  schematicUrl,
  prefabTableUrl,
  entryTitle,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Refs the native pointer handler reads so it always sees current values
  // (the handler is attached once per load and would otherwise close over
  // stale transform/hidden/hits).
  const hitsRef = useRef<PanelHit[] | null>(null);
  const transformRef = useRef<Transform>(IDENTITY_TRANSFORM);
  const hiddenRef = useRef<Set<string>>(new Set());
  const [data, setData] = useState<LoadedData | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  // Fetch + parse both inputs in parallel on mount.
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    setSelection(ALL);
    setHidden(new Set());
    setTransform(IDENTITY_TRANSFORM);
    (async () => {
      try {
        const [schemaRes, tableRes] = await Promise.all([
          fetch(schematicUrl),
          fetch(prefabTableUrl),
        ]);
        if (!schemaRes.ok) throw new Error(`schematic ${schemaRes.status}`);
        if (!tableRes.ok)  throw new Error(`prefab table ${tableRes.status}`);
        const [schematic, table] = await Promise.all([
          schemaRes.json() as Promise<Schematic>,
          tableRes.json()  as Promise<PrefabTable>,
        ]);
        if (cancelled) return;

        const lookup = buildCategoryLookup(table);
        const layout = computePanelLayout(schematic);
        const pitch  = detectGridPitch(schematic.entities, lookup);
        const geom: PanelGeom = {
          minTX: layout.minTX, maxTZ: layout.maxTZ, cell: layout.cell, pitch,
        };
        const bands = detectFloors(schematic);
        const stairRuns = detectStairRuns(schematic.entities, lookup, pitch);
        const yMin = schematic.boundingBox?.min?.[1] ?? 0;

        setData({ schematic, table, lookup, layout, geom, bands, stairRuns, yMin });
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [schematicUrl, prefabTableUrl]);

  const palette = useMemo(
    () => (data ? buildPalette(data.table) : null),
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

  // Bucket entities for the current selection. Non-stair categories slice by
  // height band; stairs are shown by run-assignment via stairCells so whole
  // flights land on their origin floor. buildPanel is a single pass — cheap
  // enough to redo on every button press.
  const panel: PanelResult | null = useMemo(() => {
    if (!data) return null;
    const stairCells =
      selection.kind === 'all'
        ? undefined
        : new Set(floorRuns.flatMap(r => r.cells.map(c => `${c.x},${c.z}`)));
    return buildPanel(
      data.schematic.entities, data.lookup, data.geom,
      toYFilter(selection, data.bands),
      { stairCells, collectHits: true },
    );
  }, [data, selection, floorRuns]);

  // Arrows come from the same runs as the fill, so they always sit on stairs.
  const stairRuns = floorRuns;

  // Keep refs current for the native pointer handler (attached once per load).
  hitsRef.current = panel?.hits ?? null;
  transformRef.current = transform;
  hiddenRef.current = hidden;

  // Size the canvas once per loaded schematic (layout doesn't change with the
  // selection — only which rects get painted does).
  useEffect(() => {
    if (!data || !canvasRef.current) return;
    configureCanvasForLayout(canvasRef.current, data.layout);
  }, [data]);

  // Repaint whenever the bucketed panel, theme, hidden set, or transform
  // changes. Only drawPanel re-runs on pan/zoom — the panel buckets are
  // memoized and unaffected — so dragging stays cheap.
  useEffect(() => {
    if (!panel || !data || !palette || !canvasRef.current) return;
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;
    drawPanel(ctx, panel, data.layout, palette, theme, {
      hiddenLayers: hidden,
      stairRuns,
      transform,
    });
  }, [panel, data, palette, theme, hidden, stairRuns, transform]);

  // Pan/zoom: wheel zooms toward the cursor, one-pointer drag pans, two-pointer
  // pinch zooms + pans. Native listeners (not Preact props) so wheel can
  // preventDefault (passive:false) and pointer capture works during drags.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data) return;
    const { drawW, drawH } = data.layout;
    const pointers = new Map<number, { x: number; y: number }>();
    let lastDist: number | null = null;
    let lastMid: { x: number; y: number } | null = null;

    const at = (e: PointerEvent | WheelEvent) =>
      clientToCanvas(canvas, e.clientX, e.clientY);

    // Hover hit-test: map the cursor to content coords, find the topmost
    // visible entity rect under it, and show its prefab name.
    const updateHover = (e: PointerEvent) => {
      const hits = hitsRef.current;
      if (!hits || !hits.length) { setHover(null); return; }
      const t = transformRef.current;
      const hiddenSet = hiddenRef.current;
      const s = at(e);
      const px = s.x / t.zoom + t.panX;
      const py = s.y / t.zoom + t.panY;
      let best: PanelHit | null = null;
      let bestRank = -1;
      for (const h of hits) {
        if (hiddenSet.has(h.layerId)) continue;
        if (px >= h.x && px <= h.x + h.w && py >= h.y && py <= h.y + h.h) {
          const rank = LAYER_INDEX.get(h.layerId) ?? -1;
          if (rank >= bestRank) { bestRank = rank; best = h; }
        }
      }
      if (!best) { setHover(null); return; }
      const wrap = canvas.parentElement;
      const rect = (wrap ?? canvas).getBoundingClientRect();
      setHover({ x: e.clientX - rect.left, y: e.clientY - rect.top, text: humanizePrefab(best.prefab) });
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
          drawW, drawH,
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
          drawW, drawH,
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
              drawW, drawH,
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
    if (!data || !panel) return null;
    const byId = new Map(data.table.categories.map(c => [c.id, c]));
    const rows: { id: string; label: string; color: string; count: number }[] = [];
    for (const [id, count] of panel.counts.entries()) {
      if (!count) continue;
      const meta = byId.get(id);
      if (meta) rows.push({ id, label: meta.label, color: meta.color, count });
    }
    rows.sort((a, b) => b.count - a.count);
    return rows;
  }, [data, panel]);

  if (error) {
    return (
      <div class="fpv fpv--error" role="alert">
        <p>Couldn’t load the floor plan: {error}.</p>
      </div>
    );
  }

  if (!data || !panel) {
    return (
      <div class="fpv fpv--loading" aria-live="polite">
        <p class="muted">Loading floor plan…</p>
      </div>
    );
  }

  const hasFloors = data.bands.length > 0;
  const hasStairArrows = stairRuns.some(r => r.path) && !hidden.has('stairs');
  const viewLabel =
    selection.kind === 'all' ? 'All floors' : data.bands[selection.index].label;

  return (
    <div class="fpv">
      <div class="fpv__head">
        <span class="fpv__title">{viewLabel}</span>
        <span class="fpv__sub muted">{panel.placed} entities</span>
      </div>

      {hasFloors && (
        <div class="fpv__controls">
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
        </div>
      )}

      <div class="fpv__canvas-wrap">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`Top-down floor plan of ${entryTitle}`}
        />
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
