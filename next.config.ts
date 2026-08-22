import type { NextConfig } from "next";
import { BASE_PATH } from "./src/lib/base-path";

const isDev = process.env.NODE_ENV !== "production";

// Next/Tailwind require inline bootstrap/styles; dev HMR also needs unsafe-eval.
// HTTPS media/connect sources permit rotating presigned storage hosts.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "font-src 'self'",
  "connect-src 'self' https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self' https://matteob.dev",
]
  .join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  // No X-Frame-Options: CSP frame-ancestors governs framing and, unlike XFO,
  // can allow a specific cross-origin embedder (matteob.dev).
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000",
  },
];

const nextConfig: NextConfig = {
  basePath: BASE_PATH,
  // onnxruntime-node's native binary must load from node_modules at runtime.
  serverExternalPackages: ["@huggingface/transformers"],
  experimental: {
    // API routes bypass Proxy; bound unauthenticated page/Server Action bodies.
    proxyClientMaxBodySize: "1mb",
  },
  // Search lives in the Library page now; keep old links working.
  async redirects() {
    return [
      { source: "/search", destination: "/library", permanent: false },
    ];
  },
  // A stale service worker can indefinitely preserve obsolete cache behavior.
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        ],
      },
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
