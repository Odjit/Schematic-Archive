/**
 * floorplan-canvas.ts — paint a buildPanel result to a 2D canvas context.
 *
 * Browser-only: depends on CanvasRenderingContext2D. The build-time SVG
 * renderer in scripts/render-floorplan.mjs uses the same buildPanel output
 * but composes SVG strings instead; both paths walk `LAYER_ORDER` and emit
 * one rect per (sx, sy, w*cell, d*cell), so a Canvas viewer rendered through
 * this module produces visually equivalent output to the static SVG.
 *
 * Pan/zoom: drawPanel takes a Transform {panX, panY, zoom} which it folds
 * into the context via translate+scale on top of whatever transform the
 * caller has already established (typically ctx.scale(dpr, dpr) for device
 * pixel ratio). Step 3 of the Canvas viewer uses Transform = identity; step
 * 4 wires the mouse/wheel handlers to feed new transform values per frame.
 */
import {
  LAYER_ORDER,
  type PanelResult,
  type PanelLayout,
  type PrefabTable,
  type StairRun,
} from './floorplan';

/** Color for the unknown/fallback category. Matches the SVG default. */
const FALLBACK_COLOR = '#888';

/**
 * Visual theme for the plot area: the panel background, its border, and the
 * grid overlay. Entity colors come from the prefab table palette and are not
 * themed here (they're designed for a light background).
 */
export interface FloorPlanTheme {
  /** Plot-area background fill. */
  panelFill: string;
  /** Plot-area border. */
  panelStroke: string;
  /** Grid line color — use an rgba() so it reads over the floor fill. */
  gridLine: string;
  /** Grid spacing in tiles. Pass the detected pitch so lines fall on cells. */
  gridStep: number;
}

/**
 * Named theme presets. 'parchment' matches the static SVG's cream look; the
 * others are exploration options. gridStep is a placeholder (10 = the common
 * V Rising pitch); callers should override it with the build's detected pitch.
 */
export const FLOORPLAN_THEMES: Record<string, Omit<FloorPlanTheme, 'gridStep'>> = {
  parchment:  { panelFill: '#ece2cc', panelStroke: '#a89878', gridLine: 'rgba(120,108,82,0.30)' },
  warmGrid:   { panelFill: '#f5efe2', panelStroke: '#cbbd9c', gridLine: 'rgba(150,120,70,0.45)' },
  slate:      { panelFill: '#e6e8ec', panelStroke: '#b3b8c2', gridLine: 'rgba(70,82,104,0.32)' },
  graphPaper: { panelFill: '#fbfbf6', panelStroke: '#cdd6c8', gridLine: 'rgba(70,130,180,0.34)' },
  blueprint:  { panelFill: '#21324a', panelStroke: '#3b5170', gridLine: 'rgba(150,190,230,0.30)' },
};

export const DEFAULT_THEME_NAME = 'blueprint';

export interface Transform {
  /** Pan offset in unzoomed pixel units. {0, 0} = no pan. */
  panX: number;
  panY: number;
  /** Linear scale. 1 = no zoom. */
  zoom: number;
}

export const IDENTITY_TRANSFORM: Transform = { panX: 0, panY: 0, zoom: 1 };

/**
 * Build a categoryId → color map from the prefab table's category list.
 * Cheap to call once per viewer mount; pass the result into drawPanel.
 */
export function buildPalette(prefabTable: PrefabTable): Map<string, string> {
  const palette = new Map<string, string>();
  for (const cat of prefabTable.categories) palette.set(cat.id, cat.color);
  return palette;
}

/**
 * Draw the building grid over the plot area, aligned to the world tile grid so
 * lines fall on actual cell boundaries (floor tiles are centered in their
 * cells, so boundaries sit at multiples of the pitch). Lines are drawn after
 * the entities with a translucent color so the grid reads over the floor fill
 * as well as the empty background.
 */
function drawGrid(
  ctx: CanvasRenderingContext2D,
  layout: PanelLayout,
  theme: FloorPlanTheme,
  zoom: number,
): void {
  const { cell, drawW, drawH, minTX, maxTZ, tilesD } = layout;
  const step = theme.gridStep;
  if (!theme.gridLine || !step || step <= 0) return;

  ctx.strokeStyle = theme.gridLine;
  // Keep grid lines ~1 CSS px regardless of zoom (line width is in the scaled
  // user space, so divide out the zoom).
  ctx.lineWidth = 1 / zoom;
  ctx.beginPath();

  // Vertical lines at world tile X = k*step.
  const firstX = Math.ceil(minTX / step) * step;
  for (let tx = firstX; (tx - minTX) * cell <= drawW; tx += step) {
    const px = Math.round((tx - minTX) * cell) + 0.5;
    ctx.moveTo(px, 0);
    ctx.lineTo(px, drawH);
  }

  // Horizontal lines at world tile Z = k*step. Panel Y is flipped (north-up),
  // so py = (maxTZ - tz) * cell.
  const minTZ = maxTZ - tilesD;
  const firstZ = Math.ceil(minTZ / step) * step;
  for (let tz = firstZ; (maxTZ - tz) * cell >= 0; tz += step) {
    const py = Math.round((maxTZ - tz) * cell) + 0.5;
    ctx.moveTo(0, py);
    ctx.lineTo(drawW, py);
  }

  ctx.stroke();
}

const STAIR_DARK = 'rgba(28,22,12,0.95)';
const STAIR_HALO = 'rgba(245,240,225,0.92)';

/**
 * Draw a stair symbol over each run: a polyline that follows the flight's
 * cell path (so L-shaped runs bend instead of cutting the corner) with an
 * arrowhead at the top end. Every arrow points up the flight, so "up" is
 * noted once in the legend rather than stamped on each staircase. Runs carry
 * tile-space cell centers; we map them to panel pixels the same way buildPanel
 * places a centered tile.
 */
function drawStairArrows(
  ctx: CanvasRenderingContext2D,
  runs: StairRun[],
  layout: PanelLayout,
): void {
  const { cell, minTX, maxTZ } = layout;
  const toPx = (c: { x: number; z: number }) => ({
    x: (c.x - minTX) * cell,
    y: (maxTZ - c.z) * cell, // north-up flip, matches buildPanel
  });

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const run of runs) {
    const path = run.path;
    if (!path || path.length < 2) continue;
    const pts = path.map(toPx);
    const tip = pts[pts.length - 1];
    const before = pts[pts.length - 2];
    let dx = tip.x - before.x;
    let dy = tip.y - before.y;
    const segLen = Math.hypot(dx, dy);
    if (segLen < 2) continue;
    const ux = dx / segLen;
    const uy = dy / segLen;

    // Arrowhead sized to the run's segment (≈ one grid cell), clamped.
    const head = Math.max(8, Math.min(16, segLen * 0.5));
    const halfW = head * 0.55;
    const baseX = tip.x - ux * head;
    const baseY = tip.y - uy * head;
    const perpX = -uy;
    const perpY = ux;

    // Stroke the path, stopping at the arrowhead base, then fill the head.
    const paint = (color: string, lw: number) => {
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.lineTo(baseX, baseY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(baseX + perpX * halfW, baseY + perpY * halfW);
      ctx.lineTo(baseX - perpX * halfW, baseY - perpY * halfW);
      ctx.closePath();
      ctx.fill();
    };
    paint(STAIR_HALO, head * 0.45 + 2); // halo underneath
    paint(STAIR_DARK, head * 0.22 + 1); // arrow on top
  }
  ctx.restore();
}

export interface DrawPanelOptions {
  /** Pan/zoom. Defaults to identity. */
  transform?: Transform;
  /** Category ids to skip painting (layer toggles). */
  hiddenLayers?: ReadonlySet<string>;
  /** Stair runs to overlay with up-arrows. Skipped if stairs are hidden. */
  stairRuns?: StairRun[];
}

/**
 * Paint one buildPanel result into `ctx`. Caller controls the rest of the
 * context state — DPR scaling, the canvas's underlying size, any wrapper
 * UI — so this stays a pure paint function.
 *
 * Order of operations:
 *   1. ctx.save() — so the transform stack doesn't leak.
 *   2. Apply pan/zoom on top of the caller's transform (typically DPR).
 *   3. Fill + stroke the plot-area background.
 *   4. Walk LAYER_ORDER, paint each non-empty, non-hidden bucket.
 *   5. Draw the grid overlay, then stair arrows.
 *   6. ctx.restore().
 *
 * The bucket walk preserves the SVG's z-stacking exactly: floor first, heart
 * last. Same dedupe semantics too — buildPanel already collapsed identical
 * (sx, sy, w, d) tuples by Map key, so each rect is painted once.
 */
export function drawPanel(
  ctx: CanvasRenderingContext2D,
  panel: PanelResult,
  layout: PanelLayout,
  palette: Map<string, string>,
  theme: FloorPlanTheme,
  opts: DrawPanelOptions = {},
): void {
  const { cell, drawW, drawH } = layout;
  const { transform = IDENTITY_TRANSFORM, hiddenLayers, stairRuns } = opts;
  const { panX, panY, zoom } = transform;

  ctx.save();
  // Apply pan+zoom additively on top of the caller's transform. This way the
  // caller can ctx.scale(dpr, dpr) for device pixel ratio once and have us
  // compose cleanly with their setup.
  ctx.translate(-panX * zoom, -panY * zoom);
  ctx.scale(zoom, zoom);

  // Plot-area background.
  ctx.fillStyle   = theme.panelFill;
  ctx.strokeStyle = theme.panelStroke;
  ctx.lineWidth   = 1;
  ctx.fillRect(0, 0, drawW, drawH);
  ctx.strokeRect(0.5, 0.5, drawW - 1, drawH - 1);

  // Entity rects, layer by layer. fillStyle changes are the dominant cost on
  // a few thousand rects; batching by layer (one fillStyle per non-empty
  // bucket) keeps the per-frame redraw cheap enough to redraw on every
  // pan/zoom event without a tile-cache.
  for (const layerId of LAYER_ORDER) {
    if (hiddenLayers?.has(layerId)) continue;
    const bucket = panel.layers.get(layerId);
    if (!bucket || bucket.size === 0) continue;
    ctx.fillStyle = palette.get(layerId) ?? FALLBACK_COLOR;
    for (const { sx, sy, w, d } of bucket.values()) {
      ctx.fillRect(sx, sy, w * cell, d * cell);
    }
  }

  // Grid overlay, then stair arrows, on top of the fills.
  drawGrid(ctx, layout, theme, zoom);
  if (stairRuns && stairRuns.length && !hiddenLayers?.has('stairs')) {
    drawStairArrows(ctx, stairRuns, layout);
  }

  ctx.restore();
}

/**
 * Set up a canvas for a given panel layout, sizing the backing store for the
 * device pixel ratio so rects stay crisp on retina/4K. Call once on mount
 * (and on DPR change, if you handle that), then drawPanel as many times as
 * pan/zoom needs.
 *
 * Returns the DPR used so the caller can fold it into other math.
 */
export function configureCanvasForLayout(
  canvas: HTMLCanvasElement,
  layout: PanelLayout,
  dpr: number = window.devicePixelRatio || 1,
): { dpr: number } {
  const { drawW, drawH } = layout;
  canvas.width  = Math.round(drawW * dpr);
  canvas.height = Math.round(drawH * dpr);
  canvas.style.width  = `${drawW}px`;
  canvas.style.height = `${drawH}px`;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    // Bake DPR into the context so callers can think in CSS pixels.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  return { dpr };
}

/**
 * Convert a pointer event's clientX/clientY to the canvas's *logical* drawing
 * coordinates (the 0..drawW × 0..drawH space drawPanel paints in). The canvas
 * is displayed at `style.width` but may be shrunk by `max-width:100%`, so we
 * rescale by drawW/rect.width. This is the display-space point `s` in
 * drawPanel's transform `s = (p - pan) * zoom`; the caller inverts it to a
 * content point for zoom-to-cursor / hit-testing.
 */
export function clientToCanvas(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const drawW = parseFloat(canvas.style.width)  || rect.width  || 1;
  const drawH = parseFloat(canvas.style.height) || rect.height || 1;
  const sx = rect.width  ? drawW / rect.width  : 1;
  const sy = rect.height ? drawH / rect.height : 1;
  return {
    x: (clientX - rect.left) * sx,
    y: (clientY - rect.top)  * sy,
  };
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;

/**
 * Clamp a transform: zoom into [MIN_ZOOM, MAX_ZOOM], and pan so the content
 * always fills the viewport (no empty margins). At zoom 1 this pins pan to 0.
 */
export function clampTransform(
  t: Transform,
  drawW: number,
  drawH: number,
): Transform {
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, t.zoom));
  const maxPanX = drawW * (1 - 1 / zoom);
  const maxPanY = drawH * (1 - 1 / zoom);
  return {
    zoom,
    panX: Math.max(0, Math.min(maxPanX, t.panX)),
    panY: Math.max(0, Math.min(maxPanY, t.panY)),
  };
}
