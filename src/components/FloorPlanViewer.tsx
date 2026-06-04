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
  type CategoryLookup,
  type FloorBand,
  type PanelGeom,
  type PanelLayout,
  type PanelResult,
  type PrefabTable,
  type Schematic,
  type StairRun,
  type YFilter,
} from '../lib/floorplan';
import {
  buildPalette,
  configureCanvasForLayout,
  drawPanel,
  FLOORPLAN_THEMES,
  DEFAULT_THEME_NAME,
  type FloorPlanTheme,
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
  const [data, setData] = useState<LoadedData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(ALL);
  // Category ids the user has toggled off in the legend.
  const [hidden, setHidden] = useState<Set<string>>(new Set());

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
      { stairCells },
    );
  }, [data, selection, floorRuns]);

  // Arrows come from the same runs as the fill, so they always sit on stairs.
  const stairRuns = floorRuns;

  // Size the canvas once per loaded schematic (layout doesn't change with the
  // selection — only which rects get painted does).
  useEffect(() => {
    if (!data || !canvasRef.current) return;
    configureCanvasForLayout(canvasRef.current, data.layout);
  }, [data]);

  // Repaint whenever the bucketed panel, theme, or hidden set changes.
  useEffect(() => {
    if (!panel || !data || !palette || !canvasRef.current) return;
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;
    drawPanel(ctx, panel, data.layout, palette, theme, {
      hiddenLayers: hidden,
      stairRuns,
    });
  }, [panel, data, palette, theme, hidden, stairRuns]);

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
