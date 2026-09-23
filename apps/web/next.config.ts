import path from "node:path";
import type { NextConfig } from "next";

// Load the shared root .env (NEXT_PUBLIC_* and API_INTERNAL_URL).
try {
  process.loadEnvFile(path.resolve(__dirname, "../../.env"));
} catch {
  /* no .env yet – defaults apply */
}

const apiInternal = (process.env.API_INTERNAL_URL || "http://localhost:4000").replace(/\/$/, "");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  compress: false, // keeps the proxied SSE stream (/api/events/stream) unbuffered
  turbopack: { root: path.resolve(__dirname, "../..") },
  outputFileTracingRoot: path.resolve(__dirname, "../.."),
  // Photo uploads (up to 20 × 25 MB) pass through the /api rewrite.
  experimental: { proxyClientMaxBodySize: "500mb" },
  // Browser → same origin /api → API server. In production Caddy routes /api
  // directly; this rewrite covers development and setups without Caddy.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiInternal}/api/:path*` }];
  },
};

export default nextConfig;
