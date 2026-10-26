import type { NextConfig } from 'next';

const config: NextConfig = {
  // Lets a second instance (e.g. the local test stack) build into its own folder.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  devIndicators: false
};

export default config;
