import type { NextConfig } from "next";

// Security headers for every page and API route. The pages' Content-Security-
// Policy has a fresh nonce per response and is set in src/proxy.ts; the API
// routes only return data, so they may load nothing at all.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];
const apiHeaders = [
  { key: "Content-Security-Policy", value: "default-src 'none'; frame-ancestors 'none'" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  output: "standalone",
  experimental: {
    // Upgrade reminders in `next dev` and `next build` only for security
    // releases (https://nextjs.org/docs/app/guides/upgrading/agent-upgrade).
    agentUpgrade: "security",
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/api/:path*", headers: apiHeaders },
    ];
  },
};

export default nextConfig;
