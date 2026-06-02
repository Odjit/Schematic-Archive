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

// --- Category (single-select) ---
export const CATEGORIES = [
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
// TODO: verify release order. Listed here in the order Odjit provided,
// which is roughly listing order, not necessarily chronological.
export const DLCS = [
  { slug: 'eldest-bloodline',   label: 'Eldest Bloodline',     fullName: "Founder's Pack: Eldest Bloodline" },
  { slug: 'castlevania',        label: 'Castlevania',          fullName: 'Legacy of Castlevania Premium Pack' },
  { slug: 'draculas-relics',    label: "Dracula's Relics",     fullName: "Dracula's Relics Pack" },
  { slug: 'sinister-evolution', label: 'Sinister Evolution',   fullName: 'Sinister Evolution Pack' },
  { slug: 'haunted-nights',     label: 'Haunted Nights',       fullName: 'Haunted Nights Castle Pack' },
  { slug: 'eternal-dominance',  label: 'Eternal Dominance',    fullName: 'Eternal Dominance Pack' }
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

// --- Game versions ---
export const GAME_VERSIONS = [
  { slug: '1.0', label: '1.0' },
  { slug: '1.1', label: '1.1' }
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

export type CategorySlug  = typeof CATEGORIES[number]['slug'];
export type TierSlug      = typeof TIERS[number]['slug'];
export type FootprintSlug = typeof FOOTPRINTS[number]['slug'];
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
