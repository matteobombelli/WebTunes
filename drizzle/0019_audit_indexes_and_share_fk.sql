-- Audit remediation (2026-06-28): FK-cascade indexes + share-link FK softening.
--
-- !! NOT a drizzle-kit migration !!  The CREATE INDEX statements use
-- CONCURRENTLY, which Postgres forbids inside a transaction (and `drizzle-kit
-- migrate` wraps each migration in one), so this file is intentionally NOT in
-- drizzle/meta/_journal.json. Apply it by hand — psql autocommits each
-- top-level statement, which CONCURRENTLY allows:
--
--     docker compose exec -T postgres \
--       psql -U webtunes -d webtunes -f - < drizzle/0019_audit_indexes_and_share_fk.sql
--
-- Everything is idempotent (IF NOT EXISTS / DROP IF EXISTS), so re-running is
-- safe. CONCURRENTLY does not lock the table for writes; the FK swap takes a
-- brief lock on the tiny track_shares table only.

-- L10: back the tracks -> {playlist_tracks, similar_exclusions} ON DELETE CASCADE
-- with a track_id index so a track delete uses an index instead of a seq scan
-- (mirrors listens_track_idx). Both PKs lead with playlist_id / user_id, so
-- neither table otherwise has a usable track_id-first index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS playlist_tracks_track_idx
  ON playlist_tracks (track_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS similar_exclusions_track_idx
  ON similar_exclusions (track_id);

-- L20: a public share row is one-per-track and is an absolute capability bound
-- to the TRACK, not to whoever first minted it (a friend may mint). created_by
-- referenced users.id ON DELETE CASCADE, so a minter deleting their account
-- silently revoked the owner's still-valid link. Make created_by nullable +
-- SET NULL so the link survives until its 7-day expiry. Atomic so the FK is
-- never absent mid-swap.
BEGIN;
ALTER TABLE track_shares ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE track_shares DROP CONSTRAINT IF EXISTS track_shares_created_by_users_id_fk;
ALTER TABLE track_shares
  ADD CONSTRAINT track_shares_created_by_users_id_fk
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
COMMIT;
