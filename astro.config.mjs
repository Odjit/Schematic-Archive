// @ts-check
import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import sitemap from '@astrojs/sitemap';

// GitHub Pages project URL: https://<user>.github.io/<repo>/
// `base` must match the repo name exactly — Pages paths are case-sensitive.
// When migrating to a custom domain later, drop `base` and update `site`.
const SITE = 'https://odjit.github.io';
const BASE = '/Schematic-Archive';

export default defineConfig({
  site: SITE,
  base: BASE,
  trailingSlash: 'always',
  integrations: [preact(), sitemap()],
  vite: {
    server: {
      // Allow serving files from builds/ during dev so screenshots and schematic
      // files referenced from manifests resolve from their source folders.
      fs: { allow: ['..'] }
    }
  }
});
