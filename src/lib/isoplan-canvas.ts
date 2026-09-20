/**
 * isoplan-canvas.ts — paint a buildIsoScene result to a 2D canvas context.
 *
 * Browser-only companion to isoplan.mjs, mirroring what floorplan-canvas.ts
 * does for the top-down plan: the scene is already sorted back-to-front, so
 * this walks it in order and fills three faces per box. Same Transform
 * (pan/zoom) contract as drawPanel, so the viewer's pointer handling is shared
 * between the two modes.
 */
import { ISO_COS, ISO_SIN, isoProject, type IsoBox, type IsoLayout, type IsoScene } from './isoplan';
import { TILES_PER_METRE } from './floorplan';
import { IDENTITY_TRANSFORM, type Transform } from './floorplan-canvas';

/** Color for the unknown/fallback category. Matches the plan renderer. */
const FALLBACK_COLOR = '#888';

/**
 * Face brightness. The light sits up and to the left, so the top face reads
 * full strength, the left (+Z) face a little dimmer, the right (+X) face
 * dimmest. Three flat tones are enough to make the boxes read as solid.
 */
const TOP_SHADE   = 1;
const LEFT_SHADE  = 0.8;
const RIGHT_SHADE = 0.62;

/**
 * Edge strokes stop helping once a box is only a few pixels across — they
 * swallow the fill and the model turns to mush. Below this drawn cell size
 * (px per tile, after zoom) we skip them.
 */
const STROKE_MIN_CELL = 2.2;
const EDGE_COLOR = 'rgba(8,12,18,0.45)';

export interface IsoTheme {
  /** Background behind the model. */
  panelFill: string;
}

export const ISO_THEMES: Record<string, IsoTheme> = {
  blueprint: { panelFill: '#15202e' },
  slate:     { panelFill: '#232830' },
  parchment: { panelFill: '#ece2cc' },
};

export const DEFAULT_ISO_THEME = 'blueprint';

/** Multiply a #rrggbb by a brightness factor, clamped. */
function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  if (!Number.isFinite(n)) return hex;
  const ch = (v: number) => Math.min(255, Math.round(v * f));
  const r = ch((n >> 16) & 255);
  const g = ch((n >> 8) & 255);
  const b = ch(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/** Cache of "#rrggbb@factor" -> shaded color, so we don't re-parse per box. */
const shadeCache = new Map<string, string>();
function shadeCached(hex: string, f: number): string {
  const key = `${hex}@${f}`;
  let v = shadeCache.get(key);
  if (v === undefined) { v = shade(hex, f); shadeCache.set(key, v); }
  return v;
}

export interface DrawIsoOptions {
  /** Pan/zoom. Defaults to identity. */
  transform?: Transform;
  /** Category ids to skip painting (legend toggles). */
  hiddenLayers?: ReadonlySet<string>;
}

/**
 * Paint one iso scene into `ctx`.
 *
 * Same shape as drawPanel: the caller owns DPR scaling and canvas sizing, we
 * own the scene transform and the pixels inside it.
 */
export function drawIsoScene(
  ctx: CanvasRenderingContext2D,
  scene: IsoScene,
  layout: IsoLayout,
  palette: Map<string, string>,
  theme: IsoTheme,
  opts: DrawIsoOptions = {},
): void {
  const { transform = IDENTITY_TRANSFORM, hiddenLayers } = opts;
  const { panX, panY, zoom } = transform;
  const { cell, originX, originY, drawW, drawH } = layout;

  ctx.save();
  ctx.translate(-panX * zoom, -panY * zoom);
  ctx.scale(zoom, zoom);

  ctx.fillStyle = theme.panelFill;
  ctx.fillRect(0, 0, drawW, drawH);

  const stroke = cell * zoom >= STROKE_MIN_CELL;
  if (stroke) {
    ctx.strokeStyle = EDGE_COLOR;
    ctx.lineWidth = Math.min(1, 0.5 / zoom);
    ctx.lineJoin = 'round';
  }

  // Visible window in the scene's own projected units. Zooming in shrinks it,
  // so most of a large build is skipped before any path work happens — without
  // this, a zoomed drag spends its time filling geometry that lands off-canvas.
  const viewU0 = (panX - originX) / cell;
  const viewU1 = (panX + drawW / zoom - originX) / cell;
  const viewV0 = (panY - originY) / cell;
  const viewV1 = (panY + drawH / zoom - originY) / cell;

  // Scratch point buffer — one box's projected coordinates, reused so a few
  // thousand boxes don't allocate a few thousand arrays per frame. The
  // projection is inlined here rather than calling isoProject for the same
  // reason: seven corners per box is ~19k returned tuples per full redraw,
  // and the resulting GC churn showed up as multi-frame stalls while panning.
  const p = new Float64Array(16);
  const put = (i: number, tx: number, tz: number, y: number) => {
    p[i * 2]     = (tx - tz) * ISO_COS * cell + originX;
    p[i * 2 + 1] = ((tx + tz) * ISO_SIN - y * TILES_PER_METRE) * cell + originY;
  };
  const face = (a: number, b: number, c: number, d: number, color: string) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(p[a * 2], p[a * 2 + 1]);
    ctx.lineTo(p[b * 2], p[b * 2 + 1]);
    ctx.lineTo(p[c * 2], p[c * 2 + 1]);
    ctx.lineTo(p[d * 2], p[d * 2 + 1]);
    ctx.closePath();
    ctx.fill();
    if (stroke) ctx.stroke();
  };

  for (const box of scene.boxes) {
    if (hiddenLayers?.has(box.layerId)) continue;
    if (box.u1 < viewU0 || box.u0 > viewU1 || box.v1 < viewV0 || box.v0 > viewV1) continue;
    const base = palette.get(box.layerId) ?? FALLBACK_COLOR;
    const x1 = box.x0 + box.w;
    const z1 = box.z0 + box.d;
    const top = box.by + box.h;

    // 0..3 = top face (far, right, near, left); 4..6 = the three base corners
    // the visible side faces need.
    put(0, box.x0, box.z0, top);
    put(1, x1,     box.z0, top);
    put(2, x1,     z1,     top);
    put(3, box.x0, z1,     top);
    put(4, x1,     box.z0, box.by);
    put(5, x1,     z1,     box.by);
    put(6, box.x0, z1,     box.by);

    // Right (+X) and left (+Z) faces first, top last so it caps them.
    face(1, 2, 5, 4, shadeCached(base, RIGHT_SHADE));
    face(2, 3, 6, 5, shadeCached(base, LEFT_SHADE));
    face(0, 1, 2, 3, shadeCached(base, TOP_SHADE));
  }

  ctx.restore();
}

/** Is (px, py) inside the quad a-b-c-d? Convex, so a consistent-sign test. */
function inQuad(
  px: number, py: number,
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  let pos = false;
  let neg = false;
  const edge = (x0: number, y0: number, x1: number, y1: number) => {
    const cross = (x1 - x0) * (py - y0) - (y1 - y0) * (px - x0);
    if (cross > 0) pos = true;
    else if (cross < 0) neg = true;
  };
  edge(ax, ay, bx, by);
  edge(bx, by, cx, cy);
  edge(cx, cy, dx, dy);
  edge(dx, dy, ax, ay);
  return !(pos && neg);
}

/**
 * Topmost box under a point, in the scene's own (unzoomed) pixel space.
 *
 * Walks the scene back to front in reverse, so the first box whose silhouette
 * contains the point is the one actually visible there — the same answer the
 * painter gave that pixel. Hidden layers are skipped so the tooltip never
 * names something the viewer can't see.
 */
export function hitTestIso(
  scene: IsoScene,
  layout: IsoLayout,
  px: number,
  py: number,
  hiddenLayers?: ReadonlySet<string>,
): IsoBox | null {
  const { cell, originX, originY } = layout;
  const at = (tx: number, tz: number, y: number): [number, number] => {
    const [sx, sy] = isoProject(tx, tz, y);
    return [sx * cell + originX, sy * cell + originY];
  };

  // The point, back in the scene's projected units — lets us reject a box on
  // its precomputed bounds before doing any quad math.
  const u = (px - originX) / cell;
  const v = (py - originY) / cell;

  for (let i = scene.boxes.length - 1; i >= 0; i--) {
    const box = scene.boxes[i];
    if (hiddenLayers?.has(box.layerId)) continue;
    if (u < box.u0 || u > box.u1 || v < box.v0 || v > box.v1) continue;
    const x1 = box.x0 + box.w;
    const z1 = box.z0 + box.d;
    const top = box.by + box.h;
    const t0 = at(box.x0, box.z0, top);
    const t1 = at(x1, box.z0, top);
    const t2 = at(x1, z1, top);
    const t3 = at(box.x0, z1, top);
    const b1 = at(x1, box.z0, box.by);
    const b2 = at(x1, z1, box.by);
    const b3 = at(box.x0, z1, box.by);
    if (
      inQuad(px, py, t0[0], t0[1], t1[0], t1[1], t2[0], t2[1], t3[0], t3[1]) ||
      inQuad(px, py, t1[0], t1[1], t2[0], t2[1], b2[0], b2[1], b1[0], b1[1]) ||
      inQuad(px, py, t2[0], t2[1], t3[0], t3[1], b3[0], b3[1], b2[0], b2[1])
    ) {
      return box;
    }
  }
  return null;
}

/**
 * Size a canvas for an iso layout, matching configureCanvasForLayout's DPR
 * handling so both modes stay crisp on retina displays.
 */
export function configureCanvasForIso(
  canvas: HTMLCanvasElement,
  layout: IsoLayout,
  dpr: number = window.devicePixelRatio || 1,
): { dpr: number } {
  const { drawW, drawH } = layout;
  canvas.width  = Math.round(drawW * dpr);
  canvas.height = Math.round(drawH * dpr);
  canvas.style.width  = `${drawW}px`;
  canvas.style.height = `${drawH}px`;
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { dpr };
}
