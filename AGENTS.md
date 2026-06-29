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
  is not). Swallow S3 delete errors. `scripts/reconcile-r2.mjs` is the backstop
  that sweeps any objects leaked by a swallowed delete (dry-run by default;
  lists the bucket, diffs against the four key columns, deletes only unreferenced
  objects older than a grace window).
- Mutations that change a playlist's contents bump `playlists.updatedAt`.
- **Auth gotcha**: credentials provider + database sessions requires the
  `jwt.encode` override in `lib/auth.ts`; do NOT set `session.strategy`
  explicitly (Auth.js asserts). Session cookie holds the DB session token.
- Invite-only registration: there is NO open sign-up path. Account creation
  lives ONLY in `registerInvitedUser` (`lib/invites.ts`) — a single transaction
  that takes a `pg_advisory_xact_lock`, enforces the `MAX_USERS = 100` total cap
  (counts demo accounts), atomically consumes a single-use invite (`UPDATE …
  WHERE used_at IS NULL AND expires_at > now()`), creates the user, and inserts
  an `accepted` `friendships` row so the invitee is **auto-friended** with the
  inviter. BOTH entry points go through it: the web `registerAction`
  (`(auth)/actions.ts`) and the mobile `POST /api/register` (which now requires
  an `invite` field in its JSON body — keep it gated). The `register` page is a
  server component that gates on `getInviteByToken` before rendering the form.
  Invite tokens are plaintext capability links like `track_shares` (re-displayable
  on the Discover → Friends → **Invite** tab), multiple concurrent per user, each
  single-use, 7-day expiry (`invites` table; `used_at` is the consumed flag — set
  before `used_by_user_id` so it survives a redeemer deletion). `INVITE_BLOCKED_
  EMAILS` (the two demo accounts) can't create invites (`POST /api/invites` 403 +
  the tab hides the button). Expired-unused rows are dead clutter (a purge
  script/timer mirroring `purge-expired-shares` is a TODO; negligible at ≤100).
- Friend-request notifications: incoming pending requests light a red
  `NotificationDot` breadcrumb (Discover nav in `Sidebar`/`MobileNav` ← layout
  fetch, the Friends `SegmentedControl` segment, the Requests tab, the Incoming
  heading). All server-rendered from `pendingRequestsFor` (`cache()`-deduped
  across the layout + discover page) — refreshes on navigation/`router.refresh`,
  no polling.
- Streaming is via presigned S3 GET URLs (1 h); the server never proxies audio.
- Public track sharing: anyone who can ACCESS a track (its owner, or a friend
  for a non-private track — the `POST /api/tracks/[id]/shares` route gates on
  `canAccessTrack`) mints a capability link anyone can open at `/share/[token]`
  to listen with no account. The kebab "Share" action (in `TrackActions`, shown
  on every track) copies the link straight to the clipboard via a transient
  `useToastStore` toast — no dialog. `lib/shares.ts` owns the `track_shares`
  table (one row per track via `UNIQUE(track_id)`, so two sharers of the same
  track get the same link; **plaintext** token on purpose, re-displayable — low
  sensitivity, unlike the hashed auth tokens). The token IS the authorization:
  the public `/api/share/[token]/stream` and `/art` routes skip
  `requireUser`/`canAccessTrack` and **override `is_private`** (`resolveShareToken`
  only checks expiry), so a link stays an ABSOLUTE capability even if the track
  later goes private or the friendship ends (until the 7-day expiry).
  `createOrGetShare` is an atomic upsert (returns an active link unchanged —
  re-sharing does NOT extend the 7d TTL; replaces an expired one). Links
  auto-expire after 7 days and are deleted by `scripts/purge-expired-shares.mjs`
  (daily `deploy/webtunes-purge-shares` timer) so they don't accumulate. The
  `/share/[token]` page is outside the `(app)`/`(auth)` groups (bare root layout,
  no auth bounce) and exempted in `src/proxy.ts`; its `<audio>`/`<img>` use
  `shareStreamSrc`/`shareArtSrc` (basePath-aware). The presigned target is
  downloadable (can't enforce stream-only).
- Loudness normalization: on upload `lib/loudness.ts` shells out to **ffmpeg**
  (a runtime dependency — must be on `PATH` in dev and prod) to measure EBU R128
  loudness into `tracks.loudness_lufs`. Best-effort like cover-art/lyrics:
  failure stores NULL and skips normalization for that track, never fails the
  upload. `scripts/analyze-loudness.mjs` backfills pre-feature rows.
- Opus re-mux: iOS Safari can't play Opus-in-Ogg (it truncates playback partway
  and auto-skips), so on upload `lib/remux.ts` losslessly re-muxes Opus to MP4
  (`ffmpeg -c:a copy` — no re-encode; verified bit-identical via a decode-free
  hash of the copied audio stream, which tolerates the benign trailing-frame
  padding MP4 carries vs Ogg) and stores `audio/mp4`. Best-effort like loudness:
  any non-Opus input or failure falls back to storing the original.
  `scripts/remux-ogg-to-mp4.mjs` backfilled the existing library — the script
  itself KEEPS each original (revert map in `remux-revert.jsonl`); the originals
  were then deleted out-of-band, so none remain in the bucket (verified via
  `scripts/reconcile-r2.mjs`, which finds zero of the 1468 mapped originals).
  The upload route runs metadata/loudness/CLAP/remux concurrently, and
  every ffmpeg subprocess (loudness, CLAP decode, remux) goes through the shared
  `lib/ffmpeg-gate.ts` semaphore (~cores-1) so parallel steps within an upload —
  and across concurrent uploads — can't oversubscribe CPU/RAM.
- "Play similar" radio: CLAP embeddings are computed in the background, not on
  the upload request — the route enqueues to `lib/clap-queue.ts` (~2 workers) and
  returns, since the embedding is the slowest upload step. Each worker re-fetches
  the stored bytes from S3 (so an upload burst can't pile audio buffers in RAM)
  and runs `lib/clap-embedding.ts`, which decodes with ffmpeg and runs the CLAP
  audio encoder (`@huggingface/transformers`, ONNX, marked
  `serverExternalPackages`; weights cached in gitignored `.transformers-cache/`)
  into a 512-d L2-normalized vector stored in the `track_embeddings` 1:1 side
  table (kept off the `tracks` row so it never loads in hot list/search paths).
  Best-effort like loudness — failure stores no row (the backfill script
  recovers it). `POST /api/tracks/[id]/similar` (body `{ limit, excludeIds }`)
  ranks accessible tracks by cosine in-DB via pgvector — the `embedding` column
  is `vector(512)` with an HNSW `vector_cosine_ops` index, and `lib/similar.ts`
  pulls a 200-row candidate pool (`embedding <=> seed`, no vectors crossing the
  wire), then Gumbel-top-k samples that pool in JS.
  **pgvector filtered-search gotcha**: that ranking runs the HNSW index UNDER
  restrictive `WHERE` filters (access rule + `similar_exclusions` + friend-dup
  dedup). Plain HNSW only explores `hnsw.ef_search` (~40) nodes and applies the
  filters *afterward*, so a seed whose acoustic neighbours are mostly inaccessible
  returns far fewer than `limit` (seen as low as 4 of 10) — seed-dependent, so it
  looks like random "play similar sometimes only fills 4–5". The fix is
  `hnsw.iterative_scan=relaxed_order`, set pool-wide beside `jit=off` in
  `src/db/index.ts` (pgvector 0.8 resumes the index until the LIMIT/POOL_SIZE is
  filled; `relaxed_order` is safe because the pool is re-scored + sampled). Any
  NEW filtered vector query inherits this — don't reintroduce per-query HNSW
  without it. The noise scale comes from the viewer's
  `users.similar_variation` (0..4, `SIGMA_BY_VARIATION` in `lib/similar.ts`;
  4 = deterministic cosine).
  The PlayerBar toggle seeds an auto-refilling queue; the client sends
  already-served ids in `excludeIds` (POST body, not a query string) to avoid
  repeats, since sampling isn't deterministic. With `users.similar_drift` (the
  default) each refill re-seeds from the currently-playing track so the radio
  drifts; off, it stays anchored to the original seed. The drift + variation +
  volume-normalization controls live in the global `SettingsModal` (gear in the
  Sidebar / mobile top bar). `scripts/analyze-clap-embeddings.mjs` backfills.
  Both the lib and the script must share the same model id + dtype (fp32) or
  embeddings stop being comparable.
- Image uploads (track cover art, playlist covers) are resolved through the
  `lib/image-upload.ts` allowlist — never echo the browser-supplied MIME type
  or filename extension back into the stored S3 Content-Type/key, since the
  offline SW replays Content-Type from a same-origin cache (stored-XSS risk).
- Online cover-art lookup: `lib/metadata-lookup.ts`'s `findCoverArt` fetches
  cover art via the iTunes Search API (no key; searches by title then album;
  upscales `100x100bb.jpg`→`600x600bb.jpg`) for tracks with an artist but no
  embedded art. Best-effort like loudness/lyrics — null on miss; the upload
  route calls it inline only when a track has an artist but no art. Remote art
  is untrusted, so the stored kind/Content-Type comes from `imageKindFromBytes`
  (magic-number sniff through the same allowlist), never the URL/response header
  — same stored-XSS reasoning as image uploads above.
  `scripts/backfill-online-metadata.mjs` backfills the existing library in two
  phases (`reextract` recovers embedded art never pulled at upload → `art` looks
  it up online); it defaults to dry-run (proposals to
  `backfill-online-review.jsonl`) and only writes with `--apply` (revert log to
  `backfill-online-revert.jsonl`). The script mirrors the lib + the
  `image-upload.ts` allowlist (keep in sync) and rate-limits iTunes.
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
- Bluetooth keep-alive: the single reused `<audio>` element pauses briefly
  between tracks; on Bluetooth (A2DP) that gap lets the output device sleep,
  and waking it for the next track flushes the previous track's ~178 ms still
  in the BT buffer as an audible glitch/bleed (inaudible on wired — tiny
  buffer, never sleeps). Nothing on the `<audio>` element (`muted`/`pause()`/
  `load()`) fixes it: those samples are downstream in the OS/BT pipeline.
  `PlayerBar`'s `ensureOutputAwake` runs a continuous inaudible Web Audio tone
  (~-80 dB / 40 Hz on its own `AudioContext`) while a track plays so the device
  never sleeps across the gap — resumed within the play gesture (autoplay
  policy requires it) and suspended on pause so it isn't holding BT open while
  idle. Corollary when debugging: a Bluetooth-only audio symptom that survives
  element-level fixes lives in the output pipeline, not the element.
- iOS playback resilience (intent vs reality): `usePlayerStore.isPlaying` is the
  play *intent*; the `<audio>` element's `paused` is *reality*. The only bridge
  that re-asserts a stuck/owed `play()` is `pendingPlayRef` + `retryPendingPlay`
  (fired by `canplay`/`stalled`/`visibilitychange`). Three iOS-only failure modes
  diverge intent from reality and each has a targeted fix in `PlayerBar`:
  - **Lock-screen / Control-Center resume — now works *while locked* via a silent
    keep-alive `<audio>`.** The MediaSession `play` handler resumes *inside the
    handler* via `attemptPlay(true)` (owed-play on a blocked resume, never a
    teardown) and the `[isPlaying]` effect guards with `if (audio.paused)` to avoid
    a second, tearing-down `play()`. That alone fixes **foreground**/Control-Center
    resume but NOT a locked screen: on-device logs (`wt-audio-debug`) proved a
    backgrounded installed PWA can't (re)start a *paused* `<audio>` — `audio.play()`
    hangs pending until foregrounded (`vis hidden` → `mediasession:play` …silence…
    → `vis visible` → N×`play-ok`). THE FIX (`silenceRef` in `PlayerBar`, gated to
    `navigator.standalone`): a second `<audio>` looping `public/silence.m4a` is
    played *through* the pause so the iOS audio session is never released — a real
    media element keeps playing in the background where the keep-alive
    `AudioContext` tone gets *suspended* (that tone, tried through the pause, did
    **not** help — reverted; this is the key difference). With the session held
    there is no cold (re)start to hang on, so the lock-screen `play` resumes the
    still-loaded track element; the silence loop is stopped in `onPlaying`. COST: a
    silent element keeps the output/device awake during a pause (battery) — hence
    the iOS-PWA-only gate. `silence.m4a` is exempted from the `src/proxy.ts` cookie
    gate like the other PWA assets. DISPLAY caveat: iOS drives Now Playing off the
    actively-playing silence element, so the scrubber is pinned to the track's
    frozen position via per-tick `setPositionState` (position is advisory →
    last-writer-wins → it holds), but the play/pause **icon** can linger on ▶ for a
    beat after a resume — iOS derives the icon from the playing element and only
    weakly honors `playbackState` (set once per transition via `setPlaybackState`);
    forcing it per-tick only causes flicker / spontaneous "playing" flips, so the
    lag is accepted. Single-element variants (mute the track) are a dead end: iOS
    ignores `element.volume`, and muting may drop the session.
  - **Involuntary pauses** (iOS handing the shared audio session to another PWA,
    then that PWA closing) fire a DOM `pause` with no transport handler, leaving
    `isPlaying` true. The `<audio onPause>` handler recovers them, gated by
    `document.visibilityState`: foreground → reconcile to paused (don't fight a
    headphone unplug / call / audio-focus loss); background → arm `pendingPlayRef`
    + retry. `expectedPauseRef` (set before every deliberate `pause()`/`src` swap,
    cleared in `onPlaying`) tags our own pauses so they aren't mistaken for
    involuntary ones.
  - **Extended background pause → iOS freezes then DISCARDS the page** (the paused
    element holds no audio session, so the page loses its freeze/discard
    exemption), wiping the in-memory zustand store → no track → no `<audio>` → no
    Now Playing controls. A minimal session snapshot (queue track DTOs + index +
    position) is persisted to `wt-player-session` on `visibilitychange→hidden` /
    `pagehide` and rehydrated **paused** on a cold mount (`hydrateSession`), with
    the playhead restored in `onLoadedMetadata`. `isPlaying:false` on restore is
    load-bearing — gesture-less autoplay at mount would recreate the keep-alive
    `AudioContext` off-gesture (BT/battery regression) and reject; the first tap
    resumes via the in-gesture path. Lock-screen controls return on that tap.
  Debugging is on-device: enable **Settings → Diagnostics → Audio debug logging**
  (sets `wt-audio-debug`), which persists `logAudio` lines to `localStorage`
  (`wt-audio-log`, survives a discard) and shows them in a copyable panel — no Mac
  / Web Inspector needed. Key markers: `mediasession:play`/`:pause` (did iOS use
  our handlers?), `play-ok`/`play-reject`, `silence:play`/`silence:reject` (did
  the keep-alive loop start?), `pause … vis=…` + `pause:bg-reclaim`/`:fg-reconcile`,
  `vis <state>`, `save idx=…`, `mount cold=… snap=…`. Corollary: a "stuck
  playing-UI with dead audio" usually means the silent keep-alive didn't hold the
  session (look for `silence:reject` / a missing `silence:play`), which falls back
  to the old behavior (resumes on foreground); "controls/queue gone after
  backgrounding" is a discard — check whether `mount cold=true` fired.

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
  immediately after building. A restart can also leave the previous `next start`
  children orphaned (reparented to init, outside the unit's cgroup, ~70 MB each
  holding a stale `.next`); after restarting, check `pgrep -af next-server` and
  reap stragglers whose cwd is this repo — the `v15` next-server is the separate
  `matteob.dev` service, not WebTunes.
- Deployed to production 2026-06-11 (OVH VPS, no written runbook yet).
  Resend domain `matteob.dev` verified; send-only key set locally and in prod.
  Without `RESEND_API_KEY`, `lib/email.ts` logs the message (reset links,
  verification links) to the server console instead of sending (dev behavior).
- Hot-path performance indexes are **hand-applied out-of-band** (CREATE INDEX
  CONCURRENTLY can't run inside drizzle's per-migration transaction): they live
  in `drizzle/0015_perf_indexes.sql` + `drizzle/0019_audit_indexes_and_share_fk.sql`,
  NOT in `src/db/schema.ts` or the journal. Apply each with
  `docker compose exec -T postgres psql -U webtunes -d webtunes -f - < <file>`
  and verify with `node scripts/check-perf-indexes.mjs` (fails loudly if any are
  missing — run after provisioning a new DB). `0019` (FK-cascade indexes on
  `playlist_tracks.track_id` / `similar_exclusions.track_id` + softens
  `track_shares.created_by` to `ON DELETE SET NULL`, matching `schema.ts`) was
  applied to prod 2026-06-28.
- Username uniqueness is also hand-applied out-of-band: `drizzle/0020_username_
  unique.sql` makes `users.name` `NOT NULL` + `UNIQUE (lower(name))` (the
  expression index lives only in raw SQL, like `search_vector`, with a comment
  in `schema.ts`). `name` IS the public username now — friend search keys on it
  (`searchUsers` in `lib/users.ts`), it's the only identifier shown to other
  users (email is never exposed: `FriendDTO` has no email), and uniqueness is
  enforced on registration (`registerInvitedUser`) and rename (`updateDisplay-
  Name`) — both pre-check `isNameTaken` and catch the index 23505 via
  `uniqueViolationConstraint`. Live "taken" warning via the public, IP-rate-
  limited `GET /api/username-available` (`useUsernameAvailability` hook). Applied
  to prod 2026-06-29.
