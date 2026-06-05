/**
 * Display labels and order for every controlled-vocabulary enum used in
 * the gallery. Changing labels here is safe; changing slugs is not (they
 * appear in URLs).
 *
 * To add a new DLC pack:
 *   1. Add its slug to the enum in schemas/manifest.schema.json.
 *   2. Append a row to DLCS below in release order.
 *   3. Done. The filter rail and detail page pick it up automatically.
 */

export type Slug<T extends readonly { slug: string }[]> = T[number]['slug'];

export const SITE_NAME = 'The Schematic Archive';
export const SITE_TAGLINE = 'Community castle blueprints for V Rising.';

// --- Type (single-select, top level) ---
// A Build is a full castle/structure. A Modular Room is a small room the
// Catacombs mod assembles into dungeons. Each Type has its own category set.
export const TYPES = [
  { slug: 'build',        label: 'Build',        plural: 'Builds' },
  { slug: 'modular-room', label: 'Modular Room', plural: 'Modular Rooms' }
] as const;

// --- Category (single-select, scoped to Type) ---
// Build categories (the original set). Slugs are URL-stable; never reorder or
// rename a slug, only append.
export const BUILD_CATEGORIES = [
  { slug: 'main-base',     label: 'Main Base' },
  { slug: 'outpost',       label: 'Outpost' },
  { slug: 'raid-base',     label: 'Raid Base' },
  { slug: 'pvp-defense',   label: 'PvP Defense' },
  { slug: 'vault',         label: 'Vault' },
  { slug: 'trader-hub',    label: 'Trader Hub' },
  { slug: 'garden',        label: 'Garden / Farm' },
  { slug: 'crafting-hall', label: 'Crafting Hall' },
  { slug: 'prison',        label: 'Prison' },
  { slug: 'boss-arena',    label: 'Boss Arena' },
  { slug: 'showcase',      label: 'Showcase' },
  { slug: 'roleplay-town', label: 'Roleplay Town' }
] as const;

// Modular Room categories (Catacombs dungeon rooms).
export const ROOM_CATEGORIES = [
  { slug: 'entrance',      label: 'Entrance' },
  { slug: 'corridor',      label: 'Corridor' },
  { slug: 'junction',      label: 'Junction' },
  { slug: 'chamber',       label: 'Chamber' },
  { slug: 'treasure-room', label: 'Treasure Room' },
  { slug: 'boss-room',     label: 'Boss Room' },
  { slug: 'trap-room',     label: 'Trap Room' },
  { slug: 'prison',        label: 'Prison' },
  { slug: 'shrine',        label: 'Shrine' },
  { slug: 'barracks',      label: 'Barracks' }
] as const;

// Which category set belongs to each Type (drives the browse rail + the form).
export const CATEGORIES_BY_TYPE = {
  'build':        BUILD_CATEGORIES,
  'modular-room': ROOM_CATEGORIES
} as const;

// Flat, slug-unique union for label lookups (labelOf) and homepage quick links.
// `prison` is shared between both sets; the build entry wins (same label), so
// every slug appears once.
export const ALL_CATEGORIES = [
  ...BUILD_CATEGORIES,
  ...ROOM_CATEGORIES.filter(r => !BUILD_CATEGORIES.some(b => b.slug === r.slug))
];

// --- Tier ---
export const TIERS = [
  { slug: 'T1', label: 'T1' },
  { slug: 'T2', label: 'T2' },
  { slug: 'T3', label: 'T3' }
] as const;

// --- Footprint ---
export const FOOTPRINTS = [
  { slug: 'small',  label: 'Small'  },
  { slug: 'medium', label: 'Medium' },
  { slug: 'large',  label: 'Large'  },
  { slug: 'max',    label: 'Max Territory' }
] as const;

// --- Placement (single, derived from the schematic) ---
// A territory save (KindredSchematics `saveterritory`) is bound to a specific
// castle territory and carries no bounding box; everything else is freely
// placeable. Derived at build time — not a submit-form field.
export const PLACEMENTS = [
  { slug: 'placeable',       label: 'Placeable',       hint: 'Drop anywhere on a valid plot' },
  { slug: 'territory-bound', label: 'Territory-bound', hint: 'Saved to a specific territory footprint' }
] as const;

// --- Game modes (multi) ---
export const MODES = [
  { slug: 'pve',  label: 'PvE'  },
  { slug: 'pvp',  label: 'PvP'  },
  { slug: 'solo', label: 'Solo' },
  { slug: 'duo',  label: 'Duo'  },
  { slug: 'trio', label: 'Trio' },
  { slug: 'clan', label: 'Clan (4+)' }
] as const;

// --- DLC / packs (multi, ANY semantics) ---
// Listed in release order (oldest to newest). When a new pack ships, append
// it to the bottom; never reorder existing entries (their slugs are URL-stable
// but the rail order is meaningful to long-time players).
export const DLCS = [
  { slug: 'eldest-bloodline',   label: 'Eldest Bloodline',     fullName: "Founder's Pack: Eldest Bloodline" },  // May 17, 2022
  { slug: 'draculas-relics',    label: "Dracula's Relics",     fullName: "Dracula's Relics Pack" },              // May 17, 2022
  { slug: 'haunted-nights',     label: 'Haunted Nights',       fullName: 'Haunted Nights Castle Pack' },         // Oct 24, 2022
  { slug: 'sinister-evolution', label: 'Sinister Evolution',   fullName: 'Sinister Evolution Pack' },            // May 17, 2023
  { slug: 'castlevania',        label: 'Castlevania',          fullName: 'Legacy of Castlevania Premium Pack' }, // May 8,  2024
  { slug: 'eternal-dominance',  label: 'Eternal Dominance',    fullName: 'Eternal Dominance Pack' }              // Apr 28, 2025
] as const;

// --- Themes (multi) ---
export const THEMES = [
  { slug: 'gothic',       label: 'Gothic' },
  { slug: 'cathedral',    label: 'Cathedral' },
  { slug: 'ruin',         label: 'Ruin' },
  { slug: 'winter',       label: 'Winter' },
  { slug: 'garden',       label: 'Garden' },
  { slug: 'symmetrical',  label: 'Symmetrical' },
  { slug: 'minimalist',   label: 'Minimalist' },
  { slug: 'maze',         label: 'Maze' },
  { slug: 'throne-room',  label: 'Throne Room' },
  { slug: 'library',      label: 'Library' },
  { slug: 'workshop',     label: 'Workshop' },
  { slug: 'dungeon',      label: 'Dungeon' }
] as const;

// --- Object-count buckets ---
// Each bucket has a slug used in URLs and a [min, max] inclusive range.
// Use Infinity for the open-ended top bucket.
export const OBJECT_BUCKETS = [
  { slug: 'lt-500',     label: 'Under 500',   min: 0,    max: 499   },
  { slug: '500-1500',   label: '500-1500',    min: 500,  max: 1500  },
  { slug: '1500-3000',  label: '1500-3000',   min: 1501, max: 3000  },
  { slug: 'gt-3000',    label: '3000+',       min: 3001, max: Number.POSITIVE_INFINITY }
] as const;

// --- Sort options ---
export const SORTS = [
  { slug: 'newest',       label: 'Newest' },
  { slug: 'oldest',       label: 'Oldest' },
  { slug: 'title',        label: 'Title (A-Z)' },
  { slug: 'author',       label: 'Author (A-Z)' },
  { slug: 'objects-desc', label: 'Largest first' },
  { slug: 'objects-asc',  label: 'Smallest first' },
  { slug: 'featured',     label: 'Featured first' }
] as const;

export type TypeSlug      = typeof TYPES[number]['slug'];
export type CategorySlug  = typeof BUILD_CATEGORIES[number]['slug'] | typeof ROOM_CATEGORIES[number]['slug'];
export type TierSlug      = typeof TIERS[number]['slug'];
export type FootprintSlug = typeof FOOTPRINTS[number]['slug'];
export type PlacementSlug = typeof PLACEMENTS[number]['slug'];
export type ModeSlug      = typeof MODES[number]['slug'];
export type DlcSlug       = typeof DLCS[number]['slug'];
export type ThemeSlug     = typeof THEMES[number]['slug'];
export type BucketSlug    = typeof OBJECT_BUCKETS[number]['slug'];
export type SortSlug      = typeof SORTS[number]['slug'];

// Lookup helpers used by components.
export const labelOf = <T extends readonly { slug: string; label: string }[]>(
  list: T,
  slug: string
): string => list.find(x => x.slug === slug)?.label ?? slug;
