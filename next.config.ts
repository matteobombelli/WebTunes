import type { NextConfig } from "next";
import { BASE_PATH } from "./src/lib/base-path";

const nextConfig: NextConfig = {
  basePath: BASE_PATH,
  // Search lives in the Library page now; keep old links working.
  async redirects() {
    return [
      { source: "/search", destination: "/library", permanent: false },
    ];
  },
};

export default nextConfig;
