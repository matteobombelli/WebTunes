# PWA Offline Playback Plan

Goal: WebTunes should load and play downloaded music while fully offline,
**without any App Store involvement**. The feature is needed for iOS, but the
implementation is standard web APIs (service worker + Cache Storage/IndexedDB),
so desktop browsers get it for free.

Status: **implemented 2026-06-12** (steps 1–6 below; verified on desktop with a
production build — offline page load, offline playback with SW-served 206
Range responses, playlist download/auto-sync/GC). Remaining:

- ~~Apply prod S3 CORS~~ — done 2026-06-12 via the Cloudflare dashboard
  (rules from `scripts/s3-cors.json`; verified preflight + ranged GET against
  a presigned URL). The R2 token in `.env.local` is object-scoped, so
  `scripts/apply-s3-cors.mjs` needs an Admin Read & Write token in the env
  to re-apply after CORS changes. Dev MinIO is already configured in
  docker-compose.yml.
- The real-device iOS pass (step 6): install to home screen, test offline
  launch + locked-screen playback + track auto-advance, standalone vs
  Safari-tab, and document the blessed mode here.

Implementation notes: `public/sw.js` (cache names `wt-shell-vN` / `wt-audio`;
the basePath is hardcoded there and must match `src/lib/base-path.ts`),
`src/lib/offline/` (IndexedDB + audio cache + orchestration),
`src/stores/downloads.ts` (queue/UI state), `/downloads` page
(`DownloadsBrowser`), `ServiceWorkerRegistrar` (registration + offline-page
priming, mounted in the (app) layout). Downloads persist until manually
deleted (no purge on access loss); downloaded playlists auto-sync on app
load when online.

## Scope

- In scope: offline app shell, per-track download to device storage, offline
  playback inside the WebTunes UI, lock-screen media controls.
- Out of scope: zip/playlist file export (explicitly rejected — the goal is
  playback *inside the app*, not exporting files), native/sideloaded apps,
  Electron/Tauri wrappers.

## Feasibility summary (verified June 2026)

- Service workers, Cache Storage, IndexedDB: supported in iOS Safari, both as
  a tab and as an installed home-screen web app.
- Storage: since Safari 17, installed home-screen web apps get up to ~60% of
  disk per origin and are **exempt from the 7-day inactivity eviction** that
  applies to regular Safari origins. Still call `navigator.storage.persist()`.
  Source: https://webkit.org/blog/14403/updates-to-storage-policy/
- No Background Fetch API on iOS: downloads only progress while the page is
  open. Acceptable for song-sized files; show a progress/queue UI.
- **The one genuine risk — background/locked-screen audio.** Installed
  (home-screen standalone) web apps have a history of iOS killing audio on
  lock/background (WebKit bug 198277), and iOS 16/17 had bugs where playback
  fails to advance to the next track in standalone mode (WebKit bug 261858;
  see also audiobookshelf issue #2655 as a canary for current iOS behavior).
  Safari-tab playback is more reliable when locked. **Fallback if standalone
  is broken on the target iOS version: use WebTunes as a Safari tab with
  offline support — offline page load and offline playback work identically;
  only the home-screen icon experience is lost.** Worst case is degraded, not
  infeasible. Test on the real device early (step 6).

## Architecture decisions

1. **Stable per-track stream URL.** Streaming today is via presigned S3 GET
   URLs (1 h expiry, different every request) — a service worker cannot
   usefully key a cache on them, and they're cross-origin. Add
   `GET /api/tracks/[id]/stream` (auth via `requireUser`, access via
   `canAccessTrack`) that 302-redirects to the presigned URL. The player
   points at this stable URL; the SW intercepts it and serves the local blob
   when the track is downloaded, otherwise lets the redirect happen.
2. **Download flow.** Client fetches the presigned URL fully (requires CORS
   config on the S3 bucket for the prod origin), stores the audio blob keyed
   by track ID, and mirrors the track DTO (and playlist DTOs) into IndexedDB
   so the offline UI has metadata. Use the existing DTO shapes from
   `src/lib/types.ts` — do not invent a parallel schema.
3. **Range requests are mandatory.** iOS `<audio>` sends Range headers and
   silently refuses to play if the SW returns a plain 200 from cache. The SW
   must slice the cached blob and return 206 Partial Content responses. This
   is the single most common offline-audio PWA gotcha.
4. **Offline UI must be client-rendered.** Existing pages are server
   components fetching via `src/lib/` — none of that renders offline. Add a
   precached client-rendered route (e.g. `/offline`) that reads track/playlist
   metadata from IndexedDB and feeds the existing player components/zustand
   store. `src/proxy.ts`'s cookie-presence gate is not a problem: the SW
   answers from cache before the network/proxy is consulted.
5. **basePath everywhere.** The app lives under `/projects/webtunes` (single
   source of truth: `src/lib/base-path.ts`). The manifest URL, SW registration
   path, SW scope, and every precached URL need the prefix. Getting this wrong
   is the most likely silent failure.

## Implementation steps

1. `GET /api/tracks/[id]/stream` route (302 to presigned URL); switch the
   player to use it. Pure refactor, verifiable online with no SW.
2. S3 bucket CORS: allow GET from the prod origin (bucket is in
   **us-east-2**). Needed before client-side full-file fetch works.
3. Web app manifest + SW registration + app-shell precache (offline route,
   player components, fonts/icons). Verify the page loads with network
   disabled in desktop DevTools.
4. Download manager: queue UI, fetch → Cache Storage blob keyed by track ID,
   DTO mirror into IndexedDB, `navigator.storage.persist()` +
   `navigator.storage.estimate()` surfaced in settings, delete/redownload.
5. SW fetch handler for the stream route: cached → Range-aware 206 serving;
   not cached → network passthrough. Verify offline playback on desktop first.
6. MediaSession API (metadata + play/pause/next/prev on lock screen), then
   the real-device iOS pass: test installed-standalone vs Safari-tab for
   locked-screen playback and track advancement; bless whichever works as the
   documented iOS mode.

Each step is independently shippable and verifiable; desktop DevTools
(offline mode, Application tab) covers steps 3–5 before any iOS testing.

## Repo conventions that apply here

- Next.js 16 in this repo differs from training data — read
  `node_modules/next/dist/docs/` before writing code; `src/proxy.ts` not
  `middleware.ts`; async `params`/`cookies()`.
- Routes stay thin: auth check + zod validation + lib call. Shared queries
  live in `src/lib/`, never duplicated in routes and pages.
- DTOs cross the API boundary (dates as ISO strings) via
  `toTrackDTO`/`toPlaylistDTO`.
- `npx tsc --noEmit` and `npx eslint src/` must stay clean.

## References

- Storage policy (quotas, eviction exemption): https://webkit.org/blog/14403/updates-to-storage-policy/
- Standalone background-audio bug: https://bugs.webkit.org/show_bug.cgi?id=198277
- Standalone track-advance bug (iOS 16/17): https://bugs.webkit.org/show_bug.cgi?id=261858
- Real-world canary (audiobookshelf): https://github.com/advplyr/audiobookshelf/issues/2655
- PWA audio capability demos: https://whatpwacando.today/audio/
