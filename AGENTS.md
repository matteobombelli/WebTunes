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
  - `users.ts` — registration; `base-path.ts` — basePath constant (single
    source of truth, imported by `next.config.ts` and `api.ts`)
  - `api.ts` — client fetch wrapper that prepends basePath; `s3.ts`, `email.ts`,
    `metadata.ts`, `types.ts` (DTO shapes shared with client)
- `src/app/api/` — REST-ish JSON routes. Some GET endpoints are unused by the
  web client but are **intentional public surface for a future mobile client —
  do not delete them**. Routes stay thin: auth check + zod validation + lib call.
- `src/app/(app)/` — authenticated pages (server components fetching via lib,
  passing DTOs to client components); `(auth)/` — login/register/reset pages.
- `src/components/` — client components; `src/stores/player.ts` — zustand
  player state (PlayerBar owns the single `<audio>` element).
- `src/proxy.ts` — cookie-presence gate only; real auth enforcement is
  server-side in `requireUser`/`requirePageUser`.

## Conventions

- Dates cross the API boundary as ISO strings; always map rows through
  `toTrackDTO`/`toPlaylistDTO` rather than returning raw Drizzle rows.
- When deleting a row that owns an S3 object, delete the DB row first, then
  the object (a leaked S3 object is harmless; a row pointing at deleted audio
  is not). Swallow S3 delete errors.
- Mutations that change a playlist's contents bump `playlists.updatedAt`.
- **Auth gotcha**: credentials provider + database sessions requires the
  `jwt.encode` override in `lib/auth.ts`; do NOT set `session.strategy`
  explicitly (Auth.js asserts). Session cookie holds the DB session token.
- Streaming is via presigned S3 GET URLs (1 h); the server never proxies audio.
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

- None — deployed to production 2026-06-11 (OVH VPS, no written runbook yet).
  Resend domain `matteob.dev` verified; send-only key set locally and in prod.
  Without `RESEND_API_KEY`, `lib/email.ts` falls back to logging reset links to
  the server console (dev behavior).
