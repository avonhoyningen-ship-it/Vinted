import path from "node:path";
import type { NextConfig } from "next";

// Load the shared root .env so NEXT_PUBLIC_* values live in one place.
try {
  process.loadEnvFile(path.resolve(__dirname, "../../.env"));
} catch {
  /* no .env yet – defaults apply */
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: { root: path.resolve(__dirname, "../..") },
};

export default nextConfig;
