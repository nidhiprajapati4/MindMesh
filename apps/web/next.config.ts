import type { NextConfig } from 'next';

// `npm run export` (or STATIC_EXPORT=1) writes plain files to `out/` for static hosting
// (Firebase Hosting). The script name is checked so it works in any shell, Windows included.
const exporting = !!process.env.STATIC_EXPORT || process.env.npm_lifecycle_event === 'export';

const config: NextConfig = exporting
  ? // An export always builds in `.next` (a custom distDir would become the export folder instead),
    // so stop `next dev` first: it uses the same folder.
    { output: 'export', devIndicators: false }
  : {
      // Lets a second instance (e.g. the local test stack) build into its own folder.
      distDir: process.env.NEXT_DIST_DIR || '.next',
      devIndicators: false,
    };

export default config;
