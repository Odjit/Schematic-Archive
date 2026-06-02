/** @jsxImportSource preact */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import MiniSearch from 'minisearch';
import {
  CATEGORIES,
  TIERS,
  FOOTPRINTS,
  MODES,
  DLCS,
  THEMES,
  OBJECT_BUCKETS,
  GAME_VERSIONS,
  SORTS,
  labelOf,
  type CategorySlug
} from '../site-config';
import {
  applyFilters,
  applySort,
  decodeState,
  encodeState,
  EMPTY_FILTERS,
  type FilterState,
  type GalleryEntry,
  type Tab
} from '../lib/filters';
import { withBase } from '../lib/url';

interface Props {
  entries: GalleryEntry[];
}

// Tiny className joiner. Astro's `class:list` does not exist in plain Preact.
const cn = (...c: (string | false | null | undefined)[]) =>
  c.filter(Boolean).join(' ');

const TABS: { slug: Tab; label: string }[] = [
  { slug: 'featured', label: 'Featured' },
  { slug: 'recent',   label: 'Recent'   },
  { slug: 'all',      label: 'All'      }
];

export default function GalleryBrowser({ entries }: Props) {
  // Hydrate initial state from the URL so deep links work on first paint.
  const [filters, setFilters] = useState<FilterState>(() =>
    typeof window === 'undefined'
      ? { ...EMPTY_FILTERS }
      : decodeState(window.location.search)
  );
  // Apply tab default: 'featured' for browse landing, but if there are zero
  // featured entries we slide silently to 'recent' so the page is not empty.
  useEffect(() => {
    if (filters.tab === 'featured' && !entries.some(e => e.featured)) {
      setFilters(f => ({ ...f, tab: 'recent' }));
    }
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reflect every filter change back to the URL.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const q = encodeState(filters);
    const next = `${window.location.pathname}${q}`;
    if (next !== window.location.pathname + window.location.search) {
      window.history.replaceState(null, '', next);
    }
  }, [filters]);

  // Build a MiniSearch index once.
  const search = useMemo(() => {
    const m = new MiniSearch<GalleryEntry>({
      fields: ['title', 'summary', 'authorName', 'tagsJoined', 'themesJoined'],
      storeFields: ['id'],
      searchOptions: { boost: { title: 3, authorName: 2 }, fuzzy: 0.2, prefix: true }
    });
    m.addAll(entries.map(e => ({
      ...e,
      authorName: e.author.name,
      tagsJoined: e.tags.join(' '),
      themesJoined: e.themes.join(' ')
    })));
    return m;
  }, [entries]);

  // Pre-filter by query (cheap, sets the working set for everything else).
  const queryFiltered = useMemo(() => {
    const q = filters.query.trim();
    if (!q) return entries;
    const hits = new Set(search.search(q).map(r => r.id as string));
    return entries.filter(e => hits.has(e.id));
  }, [entries, filters.query, search]);

  // Live-count helpers: for each dimension, count how many entries would
  // remain if that filter were applied at its current state (other filters
  // staying as they are).
  const counts = useMemo(() => {
    const base = (except: Parameters<typeof applyFilters>[2]) =>
      applyFilters(queryFiltered, filters, except);
    const within = {
      tier:        base('tier'),
      footprint:   base('footprint'),
      modes:       base('modes'),
      dlc:         base('dlc'),
      themes:      base('themes'),
      buckets:     base('buckets'),
      gameVersion: base('gameVersions'),
      category:    base('category')
    };
    const tally = <K extends string>(list: GalleryEntry[], get: (e: GalleryEntry) => K | K[]): Record<K, number> => {
      const out = {} as Record<K, number>;
      for (const e of list) {
        const got = get(e);
        const keys = Array.isArray(got) ? got : [got];
        for (const k of keys) out[k] = (out[k] ?? 0) + 1;
      }
      return out;
    };
    return {
      category:    tally(within.category,    e => e.category),
      tier:        tally(within.tier,        e => e.tier),
      footprint:   tally(within.footprint,   e => e.footprint),
      modes:       tally(within.modes,       e => e.modes),
      dlc:         tally(within.dlc,         e => e.dlc),
      themes:      tally(within.themes,      e => e.themes),
      gameVersion: tally(within.gameVersion, e => e.gameVersion),
      buckets: Object.fromEntries(
        OBJECT_BUCKETS.map(b => [b.slug, within.buckets.filter(e =>
          e.objectCount >= b.min && e.objectCount <= b.max).length])
      ) as Record<string, number>,
      vanilla: within.dlc.filter(e => e.dlc.length === 0).length
    };
  }, [queryFiltered, filters]);

  // Final visible set.
  const visible = useMemo(() => {
    return applySort(applyFilters(queryFiltered, filters), filters.sort);
  }, [queryFiltered, filters]);

  // --- Toggles ---
  const toggleArr = <K extends keyof FilterState>(key: K, value: string) => {
    setFilters(f => {
      const arr = (f[key] as unknown as string[]).slice();
      const i = arr.indexOf(value);
      if (i >= 0) arr.splice(i, 1); else arr.push(value);
      return { ...f, [key]: arr } as FilterState;
    });
  };
  const setCategory = (slug: CategorySlug | null) =>
    setFilters(f => ({ ...f, category: f.category === slug ? null : slug }));
  const setTab = (t: Tab) => setFilters(f => ({ ...f, tab: t }));
  const clearAll = () => setFilters(f => ({ ...EMPTY_FILTERS, tab: f.tab, sort: f.sort }));

  const queryRef = useRef<HTMLInputElement>(null);

  return (
    <div class="gb">
      {/* Top bar: tabs, search, sort */}
      <div class="gb__topbar">
        <div class="gb__tabs" role="tablist">
          {TABS.map(t => (
            <button
              role="tab"
              aria-selected={filters.tab === t.slug}
              class={cn('gb__tab', filters.tab === t.slug && 'active')}
              onClick={() => setTab(t.slug)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div class="gb__topright">
          <input
            ref={queryRef}
            type="search"
            placeholder="Search builds, authors, tags..."
            value={filters.query}
            onInput={(e: any) => setFilters(f => ({ ...f, query: e.currentTarget.value }))}
            class="gb__search"
          />
          <select
            class="gb__sort"
            value={filters.sort}
            onChange={(e: any) => setFilters(f => ({ ...f, sort: e.currentTarget.value }))}
            aria-label="Sort"
          >
            {SORTS.map(s => <option value={s.slug}>{s.label}</option>)}
          </select>
        </div>
      </div>

      <div class="gb__body">
        {/* Filter rail */}
        <aside class="gb__rail" aria-label="Filters">
          <Section title="Category">
            <ul class="gb__radios">
              <li>
                <button
                  class={cn('gb__radio', filters.category === null && 'active')}
                  onClick={() => setCategory(null)}
                >
                  Any
                </button>
              </li>
              {CATEGORIES.map(c => (
                <li>
                  <button
                    class={cn('gb__radio', filters.category === c.slug && 'active')}
                    onClick={() => setCategory(c.slug)}
                  >
                    <span>{c.label}</span>
                    <span class="gb__count">{counts.category[c.slug] ?? 0}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Section>

          <CheckSection
            title="Tier"
            options={TIERS}
            picked={filters.tiers}
            counts={counts.tier}
            onToggle={s => toggleArr('tiers', s)}
          />
          <CheckSection
            title="Footprint"
            options={FOOTPRINTS}
            picked={filters.footprints}
            counts={counts.footprint}
            onToggle={s => toggleArr('footprints', s)}
          />
          <CheckSection
            title="Modes"
            options={MODES}
            picked={filters.modes}
            counts={counts.modes}
            onToggle={s => toggleArr('modes', s)}
          />

          <Section title="Pieces from">
            <ul class="gb__checks">
              <li>
                <label class="gb__check">
                  <input
                    type="checkbox"
                    checked={filters.vanillaOnly}
                    onChange={() => setFilters(f => ({ ...f, vanillaOnly: !f.vanillaOnly, dlc: [] }))}
                  />
                  <span>Vanilla only</span>
                  <span class="gb__count">{counts.vanilla}</span>
                </label>
              </li>
              {DLCS.map(d => (
                <li>
                  <label class="gb__check">
                    <input
                      type="checkbox"
                      checked={filters.dlc.includes(d.slug)}
                      disabled={filters.vanillaOnly}
                      onChange={() => toggleArr('dlc', d.slug)}
                    />
                    <span title={d.fullName}>{d.label}</span>
                    <span class="gb__count">{counts.dlc[d.slug] ?? 0}</span>
                  </label>
                </li>
              ))}
            </ul>
          </Section>

          <CheckSection
            title="Themes"
            options={THEMES}
            picked={filters.themes}
            counts={counts.themes}
            onToggle={s => toggleArr('themes', s)}
          />
          <CheckSection
            title="Object count"
            options={OBJECT_BUCKETS}
            picked={filters.buckets}
            counts={counts.buckets}
            onToggle={s => toggleArr('buckets', s)}
          />
          <CheckSection
            title="Game version"
            options={GAME_VERSIONS}
            picked={filters.gameVersions}
            counts={counts.gameVersion}
            onToggle={s => toggleArr('gameVersions', s)}
          />

          <button class="gb__clear" onClick={clearAll}>Clear all</button>
        </aside>

        {/* Results grid */}
        <section class="gb__grid">
          {visible.length === 0 ? (
            <div class="gb__empty">
              <h3>No entries match.</h3>
              <p class="muted">Try clearing some filters, or search for something else.</p>
              <button class="btn" onClick={clearAll}>Clear filters</button>
            </div>
          ) : (
            <>
              <div class="gb__count-line muted">
                Showing {visible.length} of {entries.length} entries
              </div>
              <div class="gb__cards">
                {visible.map(e => <Card entry={e} />)}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

// --- Sub-components ---

function Section({ title, children }: { title: string; children: any }) {
  return (
    <div class="gb__section">
      <h4 class="gb__section-title">{title}</h4>
      {children}
    </div>
  );
}

function CheckSection({
  title, options, picked, counts, onToggle
}: {
  title: string;
  options: readonly { slug: string; label: string }[];
  picked: string[];
  counts: Record<string, number>;
  onToggle: (slug: string) => void;
}) {
  return (
    <Section title={title}>
      <ul class="gb__checks">
        {options.map(o => (
          <li>
            <label class="gb__check">
              <input
                type="checkbox"
                checked={picked.includes(o.slug)}
                onChange={() => onToggle(o.slug)}
              />
              <span>{o.label}</span>
              <span class="gb__count">{counts[o.slug] ?? 0}</span>
            </label>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Card({ entry }: { entry: GalleryEntry }) {
  const thumb = entry.thumbnail || entry.screenshots[0];
  return (
    <a class="gbc" href={withBase(`/entry/${entry.id}/`)}>
      <div class="gbc__thumb">
        <img src={withBase(`/entry-assets/${entry.id}/${thumb}`)} alt={entry.title} loading="lazy" />
        <span class="gbc__tier">{entry.tier}</span>
        <span class="gbc__cat">{labelOf(CATEGORIES, entry.category)}</span>
      </div>
      <div class="gbc__body">
        <div class="gbc__title">{entry.title}</div>
        <div class="gbc__meta">
          <span>{entry.author.name}</span>
          <span class="gbc__count">{entry.objectCount.toLocaleString()}</span>
        </div>
      </div>
    </a>
  );
}
