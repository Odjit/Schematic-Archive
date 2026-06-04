/**
 * Type declarations for floorplan.mjs.
 *
 * The runtime module is plain JavaScript (so build-time Node scripts and
 * Astro/Vite can both consume it without a TS loader). This file gives
 * `.ts`/`.tsx` callers — primarily the upcoming FloorPlanViewer Preact
 * island — proper types for editor/typecheck.
 */

// ---------------------------------------------------------------------------
// Data shapes — mirror the slim render-prefabs.json (schema v4) and the
// .kindredschematic JSON.

export interface PrefabCategory {
  id: string;
  label: string;
  color: string;
}

export interface PrefabTableEntry {
  category: string;
  /** Footprint width in tile units (X axis, unrotated). */
  w: number;
  /** Footprint depth in tile units (Z axis, unrotated). */
  d: number;
  /** Collider min Y relative to entity origin (meters). */
  y0: number;
  /** Collider max Y relative to entity origin (meters). */
  y1: number;
  /** Stair-only: cardinal direction. */
  dir?: string;
  /** Stair-only: Start / End / etc. */
  kind?: string;
}

export interface PrefabTable {
  schemaVersion: number;
  generatedAt: string;
  sourceGeneratedAt: string;
  prefabCount: number;
  categories: PrefabCategory[];
  prefabs: Record<string, PrefabTableEntry>;
}

/** One placed entity in a .kindredschematic file. */
export interface SchematicEntity {
  prefab: string;
  /** [tileX, tileZ] — present on every placed piece. */
  tilePos?: [number, number];
  /** [worldX, worldY, worldZ] in meters. */
  pos?: [number, number, number];
  /** [xDeg, yDeg, zDeg] Euler angles. */
  rot?: [number, number, number];
}

export interface Schematic {
  boundingBox?: {
    /** [tileX, worldY, tileZ] */
    min: [number, number, number];
    /** [tileX, worldY, tileZ] */
    max: [number, number, number];
  };
  entities?: SchematicEntity[];
}

// ---------------------------------------------------------------------------
// Constants.

export const LAYER_ORDER: readonly string[];
export const UNKNOWN_CATEGORY: 'other';
export const FULL_CELL_CATEGORIES: ReadonlySet<string>;
export const FALLBACK_W: number;
export const FALLBACK_D: number;
export const FALLBACK_Y0: number;
export const FALLBACK_Y1: number;
export const FLOOR_HEIGHT_M: number;
export const SLICE_EDGE_EPS: number;

// ---------------------------------------------------------------------------
// Lookup builder.

export interface PrefabLookupResult {
  id: string;
  color: string;
  label: string;
  w: number;
  d: number;
  y0: number;
  y1: number;
  /** Stairs only: Start / Part / End (+ TopFloor variants). */
  kind?: string;
  /** Stairs only: facing direction (North / East / South / West). */
  dir?: string;
  known: boolean;
}

export interface CategoryLookup {
  lookup(prefabName: string): PrefabLookupResult;
  categories: PrefabCategory[];
}

export function buildCategoryLookup(prefabTable: PrefabTable): CategoryLookup;

// ---------------------------------------------------------------------------
// Geometry + filtering.

export interface PanelGeom {
  minTX: number;
  maxTZ: number;
  cell: number;
  /**
   * Placement grid pitch in tiles, from detectGridPitch. When set, buildPanel
   * renders FULL_CELL_CATEGORIES tiles at this size so floors form a
   * continuous surface. Omit/undefined to render every tile at its collider
   * footprint.
   */
  pitch?: number | null;
}

/**
 * Full panel layout — geom + the panel's pixel and tile dimensions.
 * Superset of PanelGeom: the SVG/Canvas surface uses tilesW/tilesD/drawW/
 * drawH to size itself; buildPanel only needs the geom subset.
 */
export interface PanelLayout extends PanelGeom {
  tilesW: number;
  tilesD: number;
  drawW: number;
  drawH: number;
}

export interface PanelLayoutOptions {
  /** Target panel width in px; cell = floor(targetWidth / tilesW), clamped. Default 800. */
  targetWidth?: number;
  /** Minimum cell size in px. Default 2. */
  minCell?: number;
  /** Maximum cell size in px. Default 8. */
  maxCell?: number;
}

export function computePanelLayout(
  schematic: Schematic,
  opts?: PanelLayoutOptions,
): PanelLayout;

/**
 * Y-band filter for buildPanel.
 *   - 'center' (default): closed-open band on center Y. Each entity lands
 *     in exactly one band. Used by the static SVG per-floor panels.
 *   - 'overlap': keep entity while [pos.y + y0, pos.y + y1] overlaps
 *     [y0, y1]. Used by the Canvas viewer's continuous slider.
 */
export interface YFilter {
  mode?: 'center' | 'overlap';
  y0: number;
  y1: number;
}

export interface FloorBand {
  y0: number;
  y1: number;
  label: string;
  floorIndex: number;
  yRangeStr: string;
}

export function detectFloors(schematic: Schematic): FloorBand[];
export function swapsWidthDepth(rotEulerDeg: number[]): boolean;

/**
 * Most common non-zero spacing between adjacent floor (FULL_CELL_CATEGORIES)
 * tiles, in tiles — the placement grid pitch. null when too few floor tiles
 * to establish a grid; callers then fall back to the collider footprint.
 */
export function detectGridPitch(
  entities: SchematicEntity[] | undefined,
  lookup: CategoryLookup,
): number | null;

export interface StairRun {
  /** All grid cells (tilePos) that make up the flight. */
  cells: { x: number; z: number }[];
  /**
   * Ordered cell-center path from bottom (Start) to top (End), following the
   * flight's cells so L-shaped runs bend correctly. null if direction can't
   * be determined (draw without an arrow).
   */
  path: { x: number; z: number }[] | null;
  /** Lowest piece Y in the flight — the floor it rises from. */
  minY: number;
}

/**
 * Cluster stair pieces into flights and trace each from bottom (Start) to top
 * (End) so a renderer can draw a stair symbol + up-arrow that follows the
 * run. Coordinates are tile-space cell centers.
 */
export function detectStairRuns(
  entities: SchematicEntity[] | undefined,
  lookup: CategoryLookup,
  pitch: number | null,
): StairRun[];

// ---------------------------------------------------------------------------
// Per-panel build.

export interface PanelRect {
  sx: number;
  sy: number;
  w: number;
  d: number;
}

export interface PanelResult {
  layers: Map<string, Map<string, PanelRect>>;
  counts: Map<string, number>;
  placed: number;
  unknown: number;
  unknownSample: Set<string>;
  skippedNoTile: number;
  skippedByBand: number;
}

export interface BuildPanelOptions {
  /**
   * When set, stair-category pieces are kept iff their "tileX,tileZ" key is in
   * the set, bypassing yFilter — so a whole staircase shows on the floor it
   * rises from rather than being sliced across height bands.
   */
  stairCells?: Set<string>;
}

export function buildPanel(
  entities: SchematicEntity[] | undefined,
  lookup: CategoryLookup,
  geom: PanelGeom,
  yFilter: YFilter | null,
  opts?: BuildPanelOptions,
): PanelResult;
