<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

Already-applied v16 conventions in this repo: `src/proxy.ts` (not `middleware.ts`), async `params` in routes/pages, async `cookies()`/`headers()`.

# WebTunes

Self-hosted music library app: per-user libraries in S3, playlists, friend
sharing, full-text search (incl. lyrics). See `README.md` for stack, local
setup, and architecture rationale.

## Commands

- `npm run dev` / `npm run build && npm start` — app lives under basePath `/projects/webtunes`, even in dev
- `npx tsc --noEmit` and `npx eslint src/` — both must stay clean
- `npx drizzle-kit generate` / `migrate` — migrations in `drizzle/`
- `docker compose up -d` — dev Postgres (:5432) + MinIO (:9000)

## Layout

- `src/db/schema.ts` — Drizzle schema (single file). `search_vector` tsvector
  column exists only in raw SQL migration `drizzle/0001`, not in the schema.
- `src/lib/` — all shared server logic. **Database queries shared between API
  routes and server pages live here, never duplicated in both places:**
  - `tracks.ts` — `toTrackDTO` + track list queries (own / accessible / friend's)
  - `playlists.ts` — playlist DTO + ownership check + list/detail queries
  - `friends.ts` — friendship checks (`areFriends`; `canAccessTrack` is THE
    track-access rule), friend lists, pending requests
  - `auth.ts` — Auth.js config (see gotcha below); `auth-helpers.ts` —
    `requireUser()` (API, returns null → 401) and `requirePageUser()` (pages,
    redirects to /login)
  - `users.ts` — registration; `verification.ts` — email-verification tokens
    (hashed; `sendVerificationEmail`); `base-path.ts` — basePath constant
    (single source of truth, imported by `next.config.ts` and `api.ts`);
    `app-url.ts` — absolute base URL (origin + basePath) for email links
  - `api.ts` — client fetch wrapper that prepends basePath; `s3.ts`, `email.ts`,
    `metadata.ts`, `types.ts` (DTO shapes shared with client);
    `client-ip.ts` — best-effort client IP for rate limiting (fails closed)
  - `loudness.ts` — measures integrated loudness (EBU R128 LUFS) via ffmpeg on
    upload; `image-upload.ts` — allowlist mapping MIME/ext for cover/playlist
    images (see security note below); `use-persisted-scope.ts` — client hook
    for the own/all/friends scope selector (localStorage-backed, SSR-safe)
  - `clap-embedding.ts` — computes a CLAP audio embedding (512-d, via
    `@huggingface/transformers` + ffmpeg) on upload for "play similar";
    `similar.ts` — access-respecting cosine nearest-neighbour query over the
    `track_embeddings` side table
  - `offline/` — PWA download internals: `db.ts` (IndexedDB metadata),
    `audio-cache.ts` / `art-cache.ts` (Cache Storage), `downloads.ts` (logic)
- `src/app/api/` — REST-ish JSON routes. Some GET endpoints are unused by the
  web client but are **intentional public surface for a future mobile client —
  do not delete them**. Routes stay thin: auth check + zod validation + lib call.
- `src/app/(app)/` — authenticated pages (server components fetching via lib,
  passing DTOs to client components): library, album, artist, playlists,
  friends, downloads. `(auth)/` — login/register/forgot-password/reset-password/
  verify-email pages (+ `actions.ts` for the rate-limited form posts).
- `src/components/` — client components; `src/stores/` — zustand stores:
  `player.ts` (PlayerBar owns the single `<audio>` element), `downloads.ts`
  (offline queue/UI state), `uploads.ts` (top upload bar; survives navigation).
- `src/proxy.ts` — cookie-presence gate only; real auth enforcement is
  server-side in `requireUser`/`requirePageUser`.

## Conventions

- Dates cross the API boundary as ISO strings; always map rows through
  `toTrackDTO`/`toPlaylistDTO` rather than returning raw Drizzle rows.
- Guard `[id]`-style path params with `isUuid` (`lib/validate.ts`) before
  querying uuid columns — Postgres throws on bad casts, turning a 404 into a
  500. Unauthenticated auth endpoints (login, register, forgot-password,
  verify resend) go through `lib/rate-limit.ts` (in-memory; fine while the app
  is one Node process), keyed by client IP from `lib/client-ip.ts`.
- Security headers (CSP, HSTS, `X-Frame-Options`, etc.) are set globally in
  `next.config.ts`'s `headers()`; the CSP allows Next's inline bootstrap.
- Check-then-insert flows catch unique violations via `isUniqueViolation`
  (`src/db/index.ts`) and return their normal 409/conflict message.
- Local secrets (e.g. `POSTGRES_PASSWORD` for docker-compose interpolation)
  live in gitignored `.env*` files — never hardcode them in committed files.
- When deleting a row that owns an S3 object, delete the DB row first, then
  the object (a leaked S3 object is harmless; a row pointing at deleted audio
  is not). Swallow S3 delete errors.
- Mutations that change a playlist's contents bump `playlists.updatedAt`.
- **Auth gotcha**: credentials provider + database sessions requires the
  `jwt.encode` override in `lib/auth.ts`; do NOT set `session.strategy`
  explicitly (Auth.js asserts). Session cookie holds the DB session token.
- Streaming is via presigned S3 GET URLs (1 h); the server never proxies audio.
- Loudness normalization: on upload `lib/loudness.ts` shells out to **ffmpeg**
  (a runtime dependency — must be on `PATH` in dev and prod) to measure EBU R128
  loudness into `tracks.loudness_lufs`. Best-effort like cover-art/lyrics:
  failure stores NULL and skips normalization for that track, never fails the
  upload. `scripts/analyze-loudness.mjs` backfills pre-feature rows.
- "Play similar" radio: on upload `lib/clap-embedding.ts` decodes audio with
  ffmpeg and runs the CLAP audio encoder (`@huggingface/transformers`, ONNX,
  marked `serverExternalPackages`; weights cached in gitignored
  `.transformers-cache/`) into a 512-d L2-normalized vector stored in the
  `track_embeddings` 1:1 side table (kept off the `tracks` row so it never loads
  in hot list/search paths). Best-effort like loudness — failure stores no row.
  `GET /api/tracks/[id]/similar?offset&limit` ranks accessible tracks by cosine
  (brute-force JS, fine at personal scale); the PlayerBar toggle seeds a
  fixed-seed, auto-refilling queue. `scripts/analyze-clap-embeddings.mjs`
  backfills. Both the lib and the script must share the same model id + dtype
  (fp32) or embeddings stop being comparable.
- Image uploads (track cover art, playlist covers) are resolved through the
  `lib/image-upload.ts` allowlist — never echo the browser-supplied MIME type
  or filename extension back into the stored S3 Content-Type/key, since the
  offline SW replays Content-Type from a same-origin cache (stored-XSS risk).
- Duplicate handling: uploads are rejected (409) when the file's sha256 already
  exists in the owner's library (`tracks.content_hash`, unique per owner;
  pre-feature rows are NULL). Separately, `users.hide_friend_duplicates`
  (default true, toggled from the library page via `PATCH /api/settings`)
  hides friends' tracks whose normalized title+artist matches one of the
  viewer's own (`notDuplicateOfOwn` in `lib/tracks.ts`) in scope=all/friends
  listings and search; friend profile pages are intentionally unfiltered.
- Because of `src/proxy.ts`, Next buffers request bodies in RAM, capped by
  `experimental.proxyClientMaxBodySize` in `next.config.ts` (set to 100mb;
  default 10MB silently truncates bodies and breaks track uploads).
- Offline/PWA: the player streams via the stable
  `GET /api/tracks/[id]/stream` (302 to presigned URL); `public/sw.js` serves
  downloaded tracks from the `wt-audio` cache with Range-aware 206s (iOS
  refuses plain 200s). Cache names and the hardcoded basePath in `sw.js` must
  stay in sync with `src/lib/offline/*` and `src/lib/base-path.ts`. Download
  metadata mirrors DTOs into IndexedDB (`src/lib/offline/db.ts`); queue/UI
  state in `src/stores/downloads.ts`. Downloads persist until manually
  deleted; downloaded playlists auto-sync on app load when online.

## Production logs

- The app runs on the OVH VPS as systemd unit `webtunes.service`
  (`sh -c next start` under user `debian`, repo at `/home/debian/WebTunes`).
  All app output goes to the journal: `journalctl -u webtunes.service`
  (add `-q` to silence the "not seeing other users' messages" hint; the
  `debian` user is not in `adm`/`systemd-journal`, but the unit's own logs
  are visible).
- Postgres runs via `docker compose` on the VPS — `docker compose logs` from
  `/home/debian/WebTunes` for DB-side issues.

## Known TODOs

- PWA offline (deployed to prod 2026-06-12): prod S3 CORS applied
  2026-06-12 via the Cloudflare dashboard — the R2 token in `.env.local` is
  object-scoped, so `scripts/apply-s3-cors.mjs` gets AccessDenied unless run
  with an Admin Read & Write R2 token in the environment. (The `PWA-PLAN.md`
  design doc was removed once the feature shipped.)
- Deploys are build-in-place (`npm run build` in the live repo): the running
  server keeps references into the old `.next` and throws "Element type is
  invalid" render errors once it's replaced — restart `webtunes.service`
  immediately after building.
- Deployed to production 2026-06-11 (OVH VPS, no written runbook yet).
  Resend domain `matteob.dev` verified; send-only key set locally and in prod.
  Without `RESEND_API_KEY`, `lib/email.ts` logs the message (reset links,
  verification links) to the server console instead of sending (dev behavior).
