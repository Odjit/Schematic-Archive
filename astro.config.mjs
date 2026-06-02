// @ts-check
import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import sitemap from '@astrojs/sitemap';

// TODO: set this to the actual deployed URL when hosting is chosen.
// Cloudflare Pages default looks like: https://schematic-archive.pages.dev
const SITE = 'https://schematic-archive.example';

export default defineConfig({
  site: SITE,
  integrations: [preact(), sitemap()],
  vite: {
    server: {
      // Allow serving files from builds/ during dev so screenshots and schematic
      // files referenced from manifests resolve from their source folders.
      fs: { allow: ['..'] }
    }
  }
});
