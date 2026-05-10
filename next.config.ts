import type { NextConfig } from "next";

// GDS Analysis API base URL. Defaults to localhost for local dev; override
// via GDS_API_URL env var in deployed environments (e.g. cloudflare tunnel
// on Vercel). NOTE: a Next.js route handler at app/api/fig/[...path]/route.ts
// also exists and takes precedence — this rewrite is a fallback for cases
// where the route handler is bypassed.
const GDS_API_URL = process.env.GDS_API_URL ?? "http://localhost:8200";

const nextConfig: NextConfig = {
  // Standalone output produces .next/standalone with a self-contained Node
  // server — used by the Docker image so we don't have to ship node_modules.
  output: "standalone",
  async rewrites() {
    return [
      {
        source: "/api/fig/:path*",
        destination: `${GDS_API_URL}/fig/:path*`,
      },
    ];
  },
};

export default nextConfig;
