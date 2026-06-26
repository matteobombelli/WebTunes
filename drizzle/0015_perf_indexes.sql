-- Performance indexes for the hot list / dedup / album-artist / search paths.
--
-- These match the EXACT expressions used by the queries in src/lib/tracks.ts,
-- src/lib/playlists.ts and src/lib/friends.ts, so Postgres can actually use
-- them (a plain btree on `album`/`artist` would NOT be used — the queries wrap
-- the column in lower(btrim(...)), so a *functional* index on that expression
-- is required).
--
-- !! NOT a drizzle-kit migration !!  Every statement uses CREATE INDEX
-- CONCURRENTLY, which Postgres forbids inside a transaction — and `drizzle-kit
-- migrate` wraps each migration in one. So this file is intentionally NOT in
-- drizzle/meta/_journal.json. Apply it by hand, one statement at a time, e.g.:
--
--     docker compose exec -T db \
--       psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f - < drizzle/0015_perf_indexes.sql
--
-- (psql runs each statement in its own implicit transaction, which CONCURRENTLY
-- allows.) Everything is `IF NOT EXISTS`, so re-running is safe. Verify with
-- EXPLAIN (ANALYZE, BUFFERS) on a representative album/scope=all/search query
-- before and after. CONCURRENTLY does not lock the table for writes.
--
-- DEFERRED: do not apply while the audio backfill is running.

-- pg_trgm powers index-backed ILIKE substring search (the title/artist/album
-- branches of /api/search that the GIN tsvector can't serve).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Newest-first own/accessible track lists: WHERE owner_id = ? ORDER BY created_at DESC.
CREATE INDEX CONCURRENTLY IF NOT EXISTS tracks_owner_created_idx
  ON tracks (owner_id, created_at DESC);

-- Friend-visibility filter: owner_id IN (friends) AND is_private = false.
CREATE INDEX CONCURRENTLY IF NOT EXISTS tracks_owner_private_idx
  ON tracks (owner_id, is_private);

-- notDuplicateOfOwn(): EXISTS over the viewer's own rows by normalized title+artist.
CREATE INDEX CONCURRENTLY IF NOT EXISTS tracks_owner_titleartist_norm_idx
  ON tracks (owner_id, lower(btrim(title)), lower(btrim(coalesce(artist, ''))));

-- canonicalFriendCopy(): EXISTS joining other rows by normalized title+artist.
CREATE INDEX CONCURRENTLY IF NOT EXISTS tracks_titleartist_norm_idx
  ON tracks (lower(btrim(title)), lower(btrim(coalesce(artist, ''))));

-- Album page: WHERE lower(btrim(coalesce(album, ''))) = lower(btrim(?)).
CREATE INDEX CONCURRENTLY IF NOT EXISTS tracks_album_norm_idx
  ON tracks (lower(btrim(coalesce(album, ''))));

-- Artist page: WHERE lower(btrim(coalesce(artist, ''))) = lower(btrim(?)).
CREATE INDEX CONCURRENTLY IF NOT EXISTS tracks_artist_norm_idx
  ON tracks (lower(btrim(coalesce(artist, ''))));

-- ILIKE '%q%' substring search on the short fields (kept alongside the FTS GIN).
CREATE INDEX CONCURRENTLY IF NOT EXISTS tracks_title_trgm_idx
  ON tracks USING gin (title gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS tracks_artist_trgm_idx
  ON tracks USING gin (artist gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS tracks_album_trgm_idx
  ON tracks USING gin (album gin_trgm_ops);

-- Playlists list: WHERE owner_id = ? / owner_id IN (friends).
CREATE INDEX CONCURRENTLY IF NOT EXISTS playlists_owner_id_idx
  ON playlists (owner_id);

-- friendIdsOf()/areFriends(): status='accepted' filtered by either direction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS friendships_requester_status_idx
  ON friendships (requester_id, status);
CREATE INDEX CONCURRENTLY IF NOT EXISTS friendships_addressee_status_idx
  ON friendships (addressee_id, status);
