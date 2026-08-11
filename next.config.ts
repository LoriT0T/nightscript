import type { NextConfig } from 'next';

/**
 * Static export, for GitHub Pages.
 *
 * There are no server routes left — the browser talks to Google directly with the
 * listener's own key — so the whole app is files on a CDN. `basePath` is needed because a
 * GitHub project page is served from a subdirectory, not the domain root.
 *
 * Set NEXT_PUBLIC_BASE_PATH='' to build for a root-served host instead.
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '/nightscript';

const nextConfig: NextConfig = {
  output: 'export',
  basePath,
  // Every asset URL the app builds by hand has to carry the same prefix; this is what
  // src/lib/paths.ts reads.
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  // GitHub Pages serves /foo/ as /foo/index.html; without this, deep links 404.
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
