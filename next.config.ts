import type { NextConfig } from "next";

// All backend proxying is done by route handlers under app/api/* so we can
// read env vars at request time. No rewrites here — they get inlined at
// build time and would bake the dev fallback URL into the Docker image.
const nextConfig: NextConfig = {
  // Standalone output produces .next/standalone with a self-contained Node
  // server — used by the Docker image so we don't have to ship node_modules.
  output: "standalone",
};

export default nextConfig;
