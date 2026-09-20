/**
 * Type declarations for isoplan.mjs (see floorplan.d.ts for why the runtime
 * module is plain JS).
 */
import type { CategoryLookup, SchematicEntity, YFilter } from './floorplan';

export const ISO_COS: number;
export const ISO_SIN: number;

/** One extruded prefab. x/z/w/d are tile units; by/h are metres. */
export interface IsoBox {
  /** Min corner of the footprint, in tile space. */
  x0: number;
  z0: number;
  /** Footprint size in tile units (already rotated and scaled). */
  w: number;
  d: number;
  /** Base height in metres (world Y + the collider's y0). */
  by: number;
  /** Extrusion height in metres. */
  h: number;
  layerId: string;
  prefab: string;
  /**
   * Projected silhouette bounds in isoProject's units, precomputed so the
   * painter and hit test can cull against the viewport cheaply.
   */
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

export interface IsoScene {
  /** Sorted back to front — paint in array order. */
  boxes: IsoBox[];
  counts: Map<string, number>;
  placed: number;
  yMin: number;
}

export interface IsoLayout {
  /** Pixels per tile unit. */
  cell: number;
  /** Translation (px) that puts the scene's top-left corner at 0,0. */
  originX: number;
  originY: number;
  drawW: number;
  drawH: number;
}

export interface BuildIsoSceneOptions {
  /** Same contract as buildPanel: show whole flights on their origin floor. */
  stairCells?: Set<string>;
  /**
   * Scale applied to wall/fence heights. 1 (default) is true height; lower
   * values give a cutaway "dollhouse" read that sees over near walls.
   */
  wallHeightScale?: number;
}

export interface IsoLayoutOptions {
  targetWidth?: number;
  minCell?: number;
  maxCell?: number;
  pad?: number;
}

/** Project tile/metre space to iso screen space, in tile-sized units. */
export function isoProject(tx: number, tz: number, yM: number): [number, number];

export function buildIsoScene(
  entities: SchematicEntity[] | undefined,
  lookup: CategoryLookup,
  geom: { pitch?: number | null },
  yFilter: YFilter | null,
  opts?: BuildIsoSceneOptions,
): IsoScene;

export function computeIsoLayout(
  scene: IsoScene,
  opts?: IsoLayoutOptions,
): IsoLayout;
