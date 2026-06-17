import type { MetadataRoute } from "next";
import { BASE_PATH } from "@/lib/base-path";

// Next serves this at {BASE_PATH}/manifest.webmanifest but does NOT prefix
// the URLs inside it — every path here needs BASE_PATH explicitly.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "WebTunes",
    short_name: "WebTunes",
    description: "Your personal music library, anywhere",
    start_url: `${BASE_PATH}/library`,
    scope: `${BASE_PATH}/`,
    display: "standalone",
    background_color: "#09090b",
    theme_color: "#141417",
    icons: [
      {
        src: `${BASE_PATH}/icon-192.png`,
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: `${BASE_PATH}/icon-512.png`,
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: `${BASE_PATH}/icon-512.png`,
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
