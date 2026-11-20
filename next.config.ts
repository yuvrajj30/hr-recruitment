import type { NextConfig } from "next";
import { securityHeaders } from "./src/lib/security/headers";

const nextConfig: NextConfig = {
  // Security headers, including the Content-Security-Policy, on every response (pages, API routes, files).
  async headers() {
    const mode = { isDev: process.env.NODE_ENV === "development", isProduction: process.env.NODE_ENV === "production" };
    return [{ source: "/:path*", headers: securityHeaders(mode) }];
  },
  poweredByHeader: false,
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    serverActions: {
      // Application forms carry a resume of up to 5 MB (plus the form fields around it).
      bodySizeLimit: "6mb",
    },
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
