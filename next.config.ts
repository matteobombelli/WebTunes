import type { NextConfig } from "next";
import { BASE_PATH } from "./src/lib/base-path";

const nextConfig: NextConfig = {
  basePath: BASE_PATH,
  experimental: {
    // Proxy buffers request bodies in RAM (default cap 10MB), which truncated
    // track uploads and broke FormData parsing. 100MB covers lossless audio.
    proxyClientMaxBodySize: "100mb",
  },
  // Search lives in the Library page now; keep old links working.
  async redirects() {
    return [
      { source: "/search", destination: "/library", permanent: false },
    ];
  },
};

export default nextConfig;
