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
}

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

export function buildPanel(
  entities: SchematicEntity[] | undefined,
  lookup: CategoryLookup,
  geom: PanelGeom,
  yFilter: YFilter | null,
): PanelResult;
