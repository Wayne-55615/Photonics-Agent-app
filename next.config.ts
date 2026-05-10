import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/fig/:path*",
        destination: "http://localhost:8200/fig/:path*",
      },
    ];
  },
};

export default nextConfig;
