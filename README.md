# WebTunes

A self-hosted, web-based music app. Each user has a personal library stored in S3,
playable in the browser, organized into playlists, and automatically shared with
friends. Search covers title, artist, album, and lyrics.

Production target: https://matteob.dev/projects/webtunes
(see `docs/DEPLOYMENT.md` for the full deployment runbook).

## Stack

- Next.js (App Router, TypeScript) with basePath `/projects/webtunes`
- PostgreSQL via Drizzle ORM (full-text search with a generated tsvector + GIN index)
- Auth.js (NextAuth v5) credentials login with database sessions
- S3-compatible object storage (MinIO in dev, AWS S3 in prod), presigned URLs for streaming
- Lyrics from embedded ID3/Vorbis tags, falling back to the free LRCLIB API
- zustand for player state, Tailwind for styling

## Local development

```bash
docker compose up -d        # Postgres :5432 + MinIO :9000 (console :9001)
cp .env.example .env.local  # then set AUTH_SECRET (openssl rand -base64 32)
npm install
npx drizzle-kit migrate
npm run dev                 # http://localhost:3000/projects/webtunes
```

Note the basePath: the app lives under `/projects/webtunes` even in dev.

## Demo accounts

`node scripts/seed-demo.mjs` seeds two pre-friended demo accounts, each with
10 royalty-free tracks (music by Kevin MacLeod, incompetech.com, CC BY 4.0;
album names are demo groupings). Each account has one private track so the
sharing/privacy features can be demonstrated.

| Name  | Email           | Password |
|-------|-----------------|----------|
| Demo1 | demo1@demo.demo | Demo1    |
| Demo2 | demo2@demo.demo | Demo2    |

The script is idempotent (safe to re-run), needs the database and S3 bucket
from `docker compose up -d` plus internet access to download the tracks, and
reads `.env.local` for credentials. The passwords are deliberately short for
demos — seeding writes the hash directly, bypassing the 8-character
registration minimum.

## Commands

| Command | What |
|---|---|
| `npm run dev` | dev server |
| `npm run build && npm start` | production build / serve |
| `npx eslint src/` | lint |
| `npx drizzle-kit generate` | create migration from schema changes |
| `npx drizzle-kit migrate` | apply migrations |

## Architecture notes

- **API routes** under `src/app/api/` are plain JSON (REST-ish) so a future
  mobile client can reuse them. Session cookie doubles as a bearer-able token
  (database sessions).
- **Streaming**: the browser gets a presigned S3 GET URL (1 h expiry) per track
  and streams directly from S3/MinIO; Range requests make seeking work. The app
  server never proxies audio bytes.
- **Uploads** go through `POST /api/tracks` (multipart) so the server can parse
  tags with `music-metadata` before pushing to S3; lyrics fall back to LRCLIB.
- **Sharing**: an accepted friendship grants mutual read access to whole
  libraries (`lib/friends.ts: canAccessTrack` is the single access check used by
  track, stream, playlist-add, and search routes).
- **basePath**: single source of truth in `src/lib/base-path.ts` (imported by
  `next.config.ts` and the client fetch wrapper `lib/api.ts`).
- **Auth gotcha**: credentials provider + database sessions requires the
  `jwt.encode` override in `lib/auth.ts`; do not set `session.strategy`
  explicitly (see comment there).

## Environment

See `.env.example`. Dev values work out of the box with docker-compose.
Production values (real S3 bucket, prod `AUTH_URL`) belong in `.env.production`,
which is gitignored on purpose: it holds credentials.
