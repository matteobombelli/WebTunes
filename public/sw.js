// WebTunes service worker.
//
// Served at {BASE_PATH}/sw.js, so its natural scope covers the whole app.
// BASE_PATH must match src/lib/base-path.ts (this file is static and cannot
// import it).
//
// Caches:
//   wt-shell-vN — app shell (static assets + navigation HTML). Versioned;
//                 stale versions are deleted on activate. Bump N whenever
//                 this file's caching logic changes.
//   wt-audio    — downloaded track audio, keyed by the stable stream URL
//                 (/api/tracks/:id/stream). Written by the download manager
//                 (src/lib/offline/), read here. NEVER deleted on activate:
//                 it holds user downloads that must outlive SW updates.
//   wt-art      — downloaded track cover art, keyed by the stable art URL
//                 (/api/tracks/:id/art). Same lifecycle as wt-audio.

const BASE_PATH = "/projects/webtunes";
const SHELL_CACHE = "wt-shell-v2";
const AUDIO_CACHE = "wt-audio";
const ART_CACHE = "wt-art";
const OFFLINE_FALLBACK = `${BASE_PATH}/downloads`;

const STREAM_PATH = new RegExp(`^${BASE_PATH}/api/tracks/[^/]+/stream$`);
const ART_PATH = new RegExp(`^${BASE_PATH}/api/tracks/[^/]+/art$`);

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith("wt-shell-") && n !== SHELL_CACHE)
          .map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (STREAM_PATH.test(url.pathname)) {
    event.respondWith(serveStream(request));
  } else if (ART_PATH.test(url.pathname)) {
    event.respondWith(serveArt(request));
  } else if (url.pathname.startsWith(`${BASE_PATH}/_next/static/`)) {
    event.respondWith(cacheFirst(request));
  } else if (request.mode === "navigate") {
    event.respondWith(serveNavigation(request));
  }
});

/**
 * Downloaded audio. Cache hit → serve the blob ourselves, honoring Range:
 * iOS <audio> sends Range requests and silently refuses to play plain 200
 * responses from a SW, so 206 slicing is mandatory. Cache miss → network
 * (the route 302s to a presigned S3 URL, which the media request follows).
 */
async function serveStream(request) {
  const cache = await caches.open(AUDIO_CACHE);
  // Match on the URL, not the request: Cache API matching is confused by
  // Range headers on the request.
  const cached = await cache.match(request.url);
  if (!cached) return fetch(request);

  const blob = await cached.blob();
  const type = cached.headers.get("Content-Type") || "application/octet-stream";
  const range = parseRange(request.headers.get("Range"), blob.size);

  if (range === null) {
    return new Response(blob, {
      status: 200,
      headers: {
        "Content-Type": type,
        "Content-Length": String(blob.size),
        "Accept-Ranges": "bytes",
      },
    });
  }
  if (range === "invalid") {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${blob.size}` },
    });
  }
  const { start, end } = range;
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": type,
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${blob.size}`,
      "Accept-Ranges": "bytes",
    },
  });
}

/**
 * Downloaded cover art. Cache hit → serve the stored image (no Range dance;
 * <img> requests don't need 206). Cache miss → network (the route 302s to a
 * presigned S3 URL, which the image request follows when online).
 */
async function serveArt(request) {
  const cache = await caches.open(ART_CACHE);
  const cached = await cache.match(request.url);
  return cached || fetch(request);
}

/** null → no/unusable Range header (serve full); "invalid" → 416. */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start;
  let end;
  if (!m[1]) {
    // Suffix range: last N bytes.
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

/** Hashed immutable build assets: cache-first. */
async function cacheFirst(request) {
  const cached = await caches.match(request, { cacheName: SHELL_CACHE });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(SHELL_CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

/**
 * Page navigations: network-first so the app stays fresh, falling back to
 * the cached copy of the same page, then to the downloads page (the one
 * route designed to render fully offline).
 */
async function serveNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    // Don't cache redirect results (e.g. unauthenticated → /login) under
    // the requested URL, or the fallback would serve the wrong page.
    if (response.ok && !response.redirected) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    const fallback = await cache.match(OFFLINE_FALLBACK);
    if (fallback) return fallback;
    return new Response("Offline — open the Downloads page while online once to enable offline mode.", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  }
}
