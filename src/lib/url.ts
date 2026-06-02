/**
 * URL helper that respects the site's base path.
 *
 * GitHub Pages project sites live at /<repo>/ so every internal link needs
 * to be prefixed. Vite makes import.meta.env.BASE_URL available in both
 * Astro (build) and Preact (client island) contexts, so this single helper
 * works on both sides.
 *
 * Usage:
 *   <a href={withBase('/browse')}>Browse</a>
 *   <img src={withBase(`/entry-assets/${id}/${file}`)} />
 *   withBase('/')              // -> '/schematic-archive/'
 *   withBase('/browse')        // -> '/schematic-archive/browse'
 *   withBase('browse')         // -> '/schematic-archive/browse'   (same)
 */
const BASE = import.meta.env.BASE_URL; // always ends with '/'

export function withBase(path: string): string {
  if (!path || path === '/') return BASE;
  const clean = path.startsWith('/') ? path.slice(1) : path;
  return `${BASE}${clean}`;
}
