/**
 * Type declarations for view-model.mjs.
 *
 * Mirrors floorplan.d.ts: the runtime module is plain JS so build scripts and
 * Vite can both load it, and this file gives the `.tsx` viewer real types.
 */
import type {
  CategoryLookup,
  PrefabCategory,
  PrefabTable,
  Schematic,
} from './floorplan';

/** One distinct prefab, pre-resolved against the prefab table at build time. */
export interface ViewModelPrefab {
  /** Prefab name, e.g. "TM_Castle_Wall_Tier02_Stone". */
  n: string;
  /** Category id (matches a PrefabCategory.id). */
  c: string;
  /** Footprint width in tile units (X axis, unrotated). */
  w: number;
  /** Footprint depth in tile units (Z axis, unrotated). */
  d: number;
  /** Collider min/max Y relative to the entity origin, in meters. */
  y0: number;
  y1: number;
  /** Stairs only: Start / Part / End. */
  k?: string;
  /** Stairs only: facing direction. */
  dir?: string;
  /** Pavement/carpet only: junction shape. */
  s?: 'straight' | 'corner' | 'tee' | 'cross';
  /** Present and true when the prefab table didn't know this name. */
  u?: true;
}

/** `[prefabIndex, tileX, tileZ, worldY, rotYDeg]`. */
export type ViewModelEntity = [number, number, number, number, number];

export interface ViewModel {
  schemaVersion: number;
  generatedAt: string;
  boundingBox: Schematic['boundingBox'];
  /** Only the categories this build actually uses, in prefab-table order. */
  categories: PrefabCategory[];
  prefabs: ViewModelPrefab[];
  entities: ViewModelEntity[];
}

export const VIEW_MODEL_VERSION: number;

/** Resolve a schematic + prefab table into the slim per-entry payload. */
export function buildViewModel(
  schematic: Schematic,
  prefabTable: PrefabTable,
): ViewModel;

/**
 * Rehydrate a view model into the shapes floorplan.mjs consumes. The returned
 * `schematic` carries only boundingBox + entities, and each entity carries
 * only the components the geometry code reads (tilePos, pos[1], rot[1]).
 */
export function hydrateViewModel(vm: ViewModel): {
  schematic: Schematic;
  lookup: CategoryLookup;
};
