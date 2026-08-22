# WebTunes agent guide

## Next.js 16

This is not the Next.js represented by older training data. Before changing framework code, read the relevant guide in `node_modules/next/dist/docs/` and follow current deprecations.

Already adopted conventions:

- `src/proxy.ts`, not `middleware.ts`.
- Async page/route `params` and async `cookies()` / `headers()`.
- Generated `RouteContext<"/api/...">` types for dynamic route handlers.
- The app always runs under base path `/projects/webtunes`, including development.

## Purpose and commands

WebTunes is a self-hosted, multi-user music library backed by PostgreSQL and S3-compatible storage. It includes playlists, friend sharing, search/lyrics, imports, recommendations, and offline playback. See `README.md` for setup and architecture.

```bash
npm run dev
npm run build && npm start
npx tsc --noEmit
npx eslint src/
npx drizzle-kit generate
npx drizzle-kit migrate
docker compose up -d
```

TypeScript and ESLint must remain clean. Production builds must not require internet access.

## Code boundaries

- `src/db/schema.ts`: the single Drizzle schema. `search_vector` and several concurrent/expression indexes intentionally exist only in raw SQL migrations.
- `src/lib/`: shared server logic. Queries used by both routes and server pages live here, never in both consumers.
- `src/app/api/`: intentionally reusable JSON API for web and future mobile clients. Do not delete an endpoint merely because the web client does not call it.
- `src/app/(app)/`: authenticated server pages; `src/app/(auth)/`: unauthenticated flows.
- `src/components/`: client UI. `src/stores/player.ts` owns queue intent; `PlayerBar` owns the only track `<audio>` element.
- `src/lib/offline/`: IndexedDB and Cache Storage logic. `public/sw.js` contains matching cache names and the hard-coded base path.
- `src/lib/import/ytdlp.ts`: the only module allowed to spawn yt-dlp.

Keep routes thin: authenticate, validate, call shared logic, map the response.

## Data and API invariants

- Dates cross JSON boundaries as ISO strings. Map tracks/playlists through `toTrackDTO` / `toPlaylistDTO`; never return raw Drizzle rows.
- Validate UUID path parameters before querying UUID columns. Invalid casts become PostgreSQL errors instead of normal 404s.
- `canAccessTrack` is the canonical track rule: owners can access their tracks; friends can access non-private, non-suggested tracks. `resolveTrackMedia` applies the same rule plus owner-only Suggested Import previews.
- `notDuplicateOfOwn` implements the optional friend-duplicate filter. Friend profile pages intentionally do not apply it.
- Catch unique races with `isUniqueViolation` and return the normal conflict response.
- Playlist-content mutations bump `playlists.updatedAt`.
- Playlist duplication accepts any accessible playlist, keeps visible tracks in order, preserves privacy, omits collaborators, and copies explicit cover objects.
- Security headers live in `next.config.ts`. API routes bypass Proxy and enforce real authentication themselves.

## Authentication, accounts, and sharing

- `requireUser()` returns null for API 401s; `requirePageUser()` redirects pages to login. `src/proxy.ts` is only a cookie-presence page gate.
- Auth.js credentials plus database sessions requires the `jwt.encode` override in `lib/auth.ts`. Do not set `session.strategy`; Auth.js asserts.
- Registration is invite-only. Both web and mobile registration call `registerInvitedUser`, whose transaction locks the user-count cap, atomically consumes one invite, creates the user, and auto-friends the inviter.
- Invite tokens are plaintext, single-use, seven-day capability links. Demo accounts cannot create them.
- The shared demo-account guard also blocks uploads, imports/search, and account deletion. The UI may show showcase controls, but actions must display `Demo accounts are read-only.` without opening.
- Public track shares are absolute seven-day capabilities. Anyone who can access a track may mint one; the token overrides later privacy/friendship changes until expiry.
- Share tokens remain plaintext so active links can be re-displayed. `createOrGetShare` is atomic and does not extend an active link.
- `/share/[token]` and its stream/art routes are public and exempt from the page auth gate.
- Incoming friend-request dots are server-rendered from cached `pendingRequestsFor`; refresh through navigation, not polling.

## Storage and media

- Streaming routes return presigned S3 redirects; the app server never proxies audio.
- For rows owning S3 objects, delete the DB row first, then best-effort delete objects. A leak is safer than a dangling row; `scripts/reconcile-r2.mjs` removes old unreferenced objects.
- Never derive stored image MIME types or key extensions from browser names/headers. Use `lib/image-upload.ts` and byte sniffing for remote art.
- Upload metadata, loudness analysis, duration probing, and Opus remux are best-effort. Failures must not reject an otherwise valid upload.
- All ffmpeg work uses `lib/ffmpeg-gate.ts` so concurrent uploads cannot oversubscribe the host.
- Opus is losslessly remuxed to MP4 for iOS Safari. Non-Opus input or remux failure stores the original.
- Cover lookup/recognition fills only missing values. Conditional `WHERE col IS NULL` updates prevent races with owner edits.
- Recognition uses one polite worker. Audio never leaves the host; only Chromaprint fingerprints are sent to AcoustID.
- CLAP embeddings are computed after upload by `clap-queue`, fetched back from S3, normalized to 512 dimensions, and stored in `track_embeddings`.
- Filtered pgvector queries require pool-wide `hnsw.iterative_scan=relaxed_order` in `src/db/index.ts`; otherwise restrictive access filters can return too few neighbours.

## Import and recommendation workers

- Manual imports run server-side through the standalone `bin/yt-dlp` (`YT_DLP_PATH` may override). yt-dlp requires Node and ffmpeg on `PATH`.
- One global serial download lane is intentional: parallel YouTube downloads trigger 429s. Preserve the 60-second cooldown and bounded retries.
- Import jobs are in memory and polled every two seconds. Restart loss is acceptable because content-hash dedupe makes resubmission cheap.
- Spotify/Apple imports scrape fixed hosts, then fuzzy-match YouTube. Below-threshold and sub-100 kbps candidates are reported as missed, never guessed.
- Suggested Imports resolve seed identities in ListenBrainz batches and use only a bounded AcoustID fallback. Candidate claims form a persistent fairness queue across users.
- Accepting staged or dedupe-promoted suggestions resets `tracks.createdAt` so the accepted track appears as new.
- CLAP model id and fp32 dtype must match between runtime and backfill scripts.

## Playback and offline invariants

- `usePlayerStore.isPlaying` is intent; the media element's `paused` state is reality. `pendingPlayRef` and `retryPendingPlay` are the recovery bridge—do not introduce another.
- `expectedPauseRef` marks deliberate pauses/source swaps. Unmarked DOM pauses reconcile intent to paused so Bluetooth disconnects or audio-focus loss never resume through speakers.
- A low-level Web Audio tone holds Bluetooth output awake while playing, preventing buffered audio bleed between tracks. Suspend it while idle.
- Installed iOS PWAs also play `public/silence.m4a` through pauses and track-end loading gaps. A real media element is required because iOS suspends AudioContext in the background.
- Player sessions persist queue/index/position to `wt-player-session` on hide/pagehide and rehydrate paused after an iOS discard. Restoring paused is required by autoplay and battery constraints.
- MediaSession `seekto` is supported. Keep `seekbackward` / `seekforward` unset so iOS displays previous/next track controls.
- On-device audio diagnostics are opt-in via `localStorage.setItem("wt-audio-debug", "1")`; logs persist under `wt-audio-log`.
- Offline audio is served from `wt-audio` with Range-aware 206 responses. Downloads persist until manually deleted; downloaded playlists sync on online app load.
- `PlayerQueueWarmers` preloads nearby art and the next three tracks. The iOS silence loop keeps background auto-advance/refill alive beyond that window.

## Operational constraints

- Secrets belong only in ignored `.env*` files. Never commit credentials.
- Production runs as `webtunes.service` (user `hs`) from `/home/hs/WebTunes`; inspect app logs with `journalctl -q -u webtunes.service` and database logs with `docker compose logs`.
- Deployment builds currently replace `.next` in place. Restart the service immediately after a build, then use `pgrep -af next-server` to find stale WebTunes children.
- PostgreSQL hot-path concurrent indexes are out-of-band in `drizzle/0015_perf_indexes.sql` and `drizzle/0019_audit_indexes_and_share_fk.sql`. Apply them separately and verify with `node scripts/check-perf-indexes.mjs`.
- Case-insensitive username uniqueness is out-of-band in `drizzle/0020_username_unique.sql`; registration and rename must still pre-check and catch its 23505 race.
- Production R2 CORS may require an Admin Read & Write token; the normal object-scoped token cannot apply bucket CORS.
- Daily timers purge expired share links and expired unused invite links, back up Postgres to R2, and self-update yt-dlp (unit definitions in `deploy/`).

## Comments and maintenance

Prefer comments that preserve a non-obvious invariant, security boundary, external platform quirk, or destructive-operation ordering. Remove narration, historical implementation stories, and comments that simply restate the code. Keep migrations and repeatable backfills needed by older self-hosted installations; remove completed one-off incident recovery tooling.

Do not modify or discard unrelated work in a dirty worktree. Never create a commit unless the user explicitly asks for one.
