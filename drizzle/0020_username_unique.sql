-- Username uniqueness (out-of-band, like 0015/0019).
--
-- `users.name` is now the public username: required and unique
-- case-insensitively. Apply by hand, NOT via drizzle-kit migrate:
--   docker compose exec -T postgres psql -U webtunes -d webtunes -f - < drizzle/0020_username_unique.sql
--
-- Safe on the current data set (verified: 0 NULL names, 0 case-insensitive
-- duplicates). If a future DB has either, these statements fail loudly — resolve
-- the offending rows first.

ALTER TABLE users ALTER COLUMN name SET NOT NULL;

-- Case-insensitive uniqueness. Lives only here (and as a comment in schema.ts),
-- exactly like the search_vector index — drizzle has no expression-index type.
CREATE UNIQUE INDEX IF NOT EXISTS users_name_lower_idx ON users (lower(name));
