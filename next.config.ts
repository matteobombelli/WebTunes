import type { NextConfig } from "next";
import { BASE_PATH } from "./src/lib/base-path";

const isDev = process.env.NODE_ENV !== "production";

// Content-Security-Policy. Next's app router injects inline bootstrap/hydration
// scripts and Tailwind injects inline styles, so script/style need
// 'unsafe-inline' (a nonce-based policy would require threading a nonce through
// the proxy - a future hardening step). Dev additionally needs 'unsafe-eval'
// for the webpack/HMR runtime. img/media/connect allow https: so presigned S3
// redirects (cover art, audio streaming) load without hardcoding the storage
// host. The high-value directives - object-src, base-uri, frame-ancestors,
// form-action - stay locked down.
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
  "frame-ancestors 'self'",
]
  .join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
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
  // @huggingface/transformers loads onnxruntime-node's native .node binary at
  // runtime (CLAP audio embeddings, lib/clap-embedding.ts); bundling it breaks
  // the build, so keep it external and required from node_modules at runtime.
  serverExternalPackages: ["@huggingface/transformers"],
  experimental: {
    // Proxy only gates page routes; API routes (including the 90 MB upload
    // endpoint) are excluded by src/proxy.ts. Keep page/Server Action body
    // buffering small so unauthenticated requests cannot reserve large chunks
    // of memory before authentication runs.
    proxyClientMaxBodySize: "1mb",
  },
  // Search lives in the Library page now; keep old links working.
  async redirects() {
    return [
      { source: "/search", destination: "/library", permanent: false },
    ];
  },
  // The service worker must never be served stale, or updates to its
  // caching logic would take a browser-dependent eternity to roll out.
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
