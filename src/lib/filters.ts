/**
 * Filter, sort, and count logic shared between the static SSR grid (in
 * browse.astro) and the interactive GalleryBrowser island.
 *
 * Keep this file framework-free so it can be imported from either side.
 */

import {
  OBJECT_BUCKETS,
  type BucketSlug,
  type CategorySlug,
  type DlcSlug,
  type FootprintSlug,
  type ModeSlug,
  type PlacementSlug,
  type SortSlug,
  type ThemeSlug,
  type TierSlug
} from '../site-config';

// Shape of one entry in gallery-index.json. Trimmed of the heavier fields
// (warnings, full markdown body) that the gallery list does not need.
export interface GalleryEntry {
  id: string;
  title: string;
  summary: string;
  author: { name: string; discord?: string; github?: string };
  category: CategorySlug;
  tier: TierSlug;
  footprint: FootprintSlug;
  modes: ModeSlug[];
  dlc: DlcSlug[];
  themes: ThemeSlug[];
  objectCount: number;
  /** Optional. V Rising game version — no longer collected; kept for legacy entries. */
  gameVersion?: string;
  /** Optional. KindredSchematics mod compatibility, maintainer-set when known. */
  modVersion?: string;
  /** How the build is placed in-game, derived from the schematic. */
  placement?: PlacementSlug;
  /** The schematic file's format version (e.g. "1.0.1"), derived. */
  schematicVersion?: string;
  thumbnail: string;
  screenshots: string[];
  schematicFile: string;
  submittedAt: string;
  updatedAt?: string;
  featured: boolean;
  tags: string[];
  /**
   * Auto-generated top-down floor plan. The build step writes
   * entry-assets/<id>/floorplan.svg whenever a real schematic is present,
   * but always advertises it here — consumers must check that the asset
   * actually exists before rendering it (entries shipped with a text
   * placeholder won't get one).
   */
  floorplan?: string;
  warnings?: string | null;
  /**
   * Present only when the schematic ships containers with items still in
   * them (auto-detected from `InventoryBuffer` slots at build time). Absent
   * means every container is empty — the common, clean-export case.
   *   inventories — distinct non-empty containers/stations
   *   stacks      — total filled slots across them
   */
  storedItems?: { inventories: number; stacks: number };
}

export type Tab = 'featured' | 'recent' | 'all';

export interface FilterState {
  tab: Tab;
  query: string;
  category: CategorySlug | null;
  tiers: TierSlug[];
  footprints: FootprintSlug[];
  modes: ModeSlug[];
  dlc: DlcSlug[];        // ANY semantics; 'vanilla' pseudo handled separately
  vanillaOnly: boolean;
  themes: ThemeSlug[];
  buckets: BucketSlug[];
  sort: SortSlug;
}

export const EMPTY_FILTERS: FilterState = {
  tab: 'featured',
  query: '',
  category: null,
  tiers: [],
  footprints: [],
  modes: [],
  dlc: [],
  vanillaOnly: false,
  themes: [],
  buckets: [],
  sort: 'newest'
};

// --- Predicate per filter dimension ---

const matchTab = (e: GalleryEntry, t: Tab) =>
  t === 'all' || t === 'recent' || (t === 'featured' && e.featured);

const matchCategory = (e: GalleryEntry, c: CategorySlug | null) =>
  !c || e.category === c;

const anyOf = <T extends string>(picked: T[], have: T[] | T) =>
  picked.length === 0 ||
  (Array.isArray(have) ? have.some(h => picked.includes(h)) : picked.includes(have));

const allOf = <T extends string>(picked: T[], have: T[]) =>
  picked.length === 0 || picked.every(p => have.includes(p));

const matchBuckets = (n: number, picked: BucketSlug[]) => {
  if (picked.length === 0) return true;
  return picked.some(slug => {
    const b = OBJECT_BUCKETS.find(x => x.slug === slug);
    return b ? n >= b.min && n <= b.max : false;
  });
};

const matchDlc = (e: GalleryEntry, picked: DlcSlug[], vanillaOnly: boolean) => {
  if (vanillaOnly && e.dlc.length > 0) return false;
  if (picked.length === 0) return true;
  return e.dlc.some(d => picked.includes(d));
};

const matchQuery = (e: GalleryEntry, q: string) => {
  if (!q.trim()) return true;
  const needle = q.toLowerCase();
  return (
    e.title.toLowerCase().includes(needle) ||
    e.summary.toLowerCase().includes(needle) ||
    e.author.name.toLowerCase().includes(needle) ||
    e.tags.some(t => t.includes(needle)) ||
    e.themes.some(t => t.includes(needle))
  );
};

// Apply every dimension EXCEPT the one named, so the rail can show
// "if I added this filter, how many would I see" counts that do not
// collapse to zero as the user narrows.
type Dim =
  | 'tab' | 'query' | 'category' | 'tier' | 'footprint' | 'modes'
  | 'dlc' | 'themes' | 'buckets';

export function applyFilters(
  entries: GalleryEntry[],
  f: FilterState,
  except?: Dim
): GalleryEntry[] {
  return entries.filter(e => {
    if (except !== 'tab'          && !matchTab(e, f.tab))                       return false;
    if (except !== 'query'        && !matchQuery(e, f.query))                   return false;
    if (except !== 'category'     && !matchCategory(e, f.category))             return false;
    if (except !== 'tier'         && !anyOf(f.tiers, e.tier))                   return false;
    if (except !== 'footprint'    && !anyOf(f.footprints, e.footprint))         return false;
    if (except !== 'modes'        && !anyOf(f.modes, e.modes))                  return false;
    if (except !== 'dlc'          && !matchDlc(e, f.dlc, f.vanillaOnly))        return false;
    if (except !== 'themes'       && !anyOf(f.themes, e.themes))                return false;
    if (except !== 'buckets'      && !matchBuckets(e.objectCount, f.buckets))   return false;
    return true;
  });
}

// --- Sorting ---

export function applySort(entries: GalleryEntry[], sort: SortSlug): GalleryEntry[] {
  const copy = entries.slice();
  const dateOf = (e: GalleryEntry) => Date.parse(e.updatedAt ?? e.submittedAt);
  switch (sort) {
    case 'newest':       return copy.sort((a, b) => dateOf(b) - dateOf(a));
    case 'oldest':       return copy.sort((a, b) => dateOf(a) - dateOf(b));
    case 'title':        return copy.sort((a, b) => a.title.localeCompare(b.title));
    case 'author':       return copy.sort((a, b) => a.author.name.localeCompare(b.author.name));
    case 'objects-desc': return copy.sort((a, b) => b.objectCount - a.objectCount);
    case 'objects-asc':  return copy.sort((a, b) => a.objectCount - b.objectCount);
    case 'featured':     return copy.sort((a, b) => Number(b.featured) - Number(a.featured) || dateOf(b) - dateOf(a));
  }
}

// --- URL state ---

export function encodeState(f: FilterState): string {
  const p = new URLSearchParams();
  if (f.tab !== 'featured') p.set('tab', f.tab);
  if (f.query) p.set('q', f.query);
  if (f.category) p.set('cat', f.category);
  if (f.tiers.length) p.set('tier', f.tiers.join(','));
  if (f.footprints.length) p.set('size', f.footprints.join(','));
  if (f.modes.length) p.set('mode', f.modes.join(','));
  if (f.dlc.length) p.set('dlc', f.dlc.join(','));
  if (f.vanillaOnly) p.set('vanilla', '1');
  if (f.themes.length) p.set('theme', f.themes.join(','));
  if (f.buckets.length) p.set('obj', f.buckets.join(','));
  if (f.sort !== 'newest') p.set('sort', f.sort);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function decodeState(search: string): FilterState {
  const p = new URLSearchParams(search);
  const split = <T extends string>(k: string): T[] =>
    (p.get(k) ?? '').split(',').map(s => s.trim()).filter(Boolean) as T[];
  return {
    ...EMPTY_FILTERS,
    tab: (p.get('tab') as Tab) ?? 'featured',
    query: p.get('q') ?? '',
    category: (p.get('cat') as CategorySlug | null) ?? null,
    tiers: split<TierSlug>('tier'),
    footprints: split<FootprintSlug>('size'),
    modes: split<ModeSlug>('mode'),
    dlc: split<DlcSlug>('dlc'),
    vanillaOnly: p.get('vanilla') === '1',
    themes: split<ThemeSlug>('theme'),
    buckets: split<BucketSlug>('obj'),
    sort: (p.get('sort') as SortSlug) ?? 'newest'
  };
}
