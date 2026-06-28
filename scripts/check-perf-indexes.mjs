// Asserts the hand-applied performance indexes exist. They live ONLY in
// drizzle/0015_perf_indexes.sql + drizzle/0019_audit_indexes_and_share_fk.sql
// (CREATE INDEX CONCURRENTLY can't run inside drizzle's per-migration
// transaction), so they are NOT in src/db/schema.ts or the migration journal.
// A freshly provisioned / rebuilt DB that skipped the hand-apply step would
// silently degrade every hot list/search/album/artist query to a seq scan with
// no error from the tooling — this fails loudly instead. Run it after any
// provisioning, or in CI.
//   node scripts/check-perf-indexes.mjs
// DATABASE_URL comes from the process environment when set, otherwise merged
// from the .env files (later files win).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILES = [".env.production", ".env", ".env.local"];

function parseEnvFile(path) {
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.includes("=") && !line.startsWith("#"))
      .map((line) => {
        const i = line.indexOf("=");
        return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
      })
  );
}

function loadEnv() {
  // Merge env files (later win), then overlay process.env LAST so an explicit
  // export wins (matches the other scripts + apply-s3-*.mjs).
  let fileEnv = {};
  for (const f of ENV_FILES) {
    const path = join(root, f);
    if (existsSync(path)) fileEnv = { ...fileEnv, ...parseEnvFile(path) };
  }
  return { ...fileEnv, ...process.env };
}

// The out-of-band indexes that back the hot paths. Keep in sync with the two
// SQL files referenced above.
const REQUIRED = [
  // 0015_perf_indexes.sql
  "tracks_owner_created_idx",
  "tracks_owner_private_idx",
  "tracks_owner_titleartist_norm_idx",
  "tracks_titleartist_norm_idx",
  "tracks_album_norm_idx",
  "tracks_artist_norm_idx",
  "tracks_title_trgm_idx",
  "tracks_artist_trgm_idx",
  "tracks_album_trgm_idx",
  "playlists_owner_id_idx",
  "friendships_requester_status_idx",
  "friendships_addressee_status_idx",
  // 0019_audit_indexes_and_share_fk.sql
  "playlist_tracks_track_idx",
  "similar_exclusions_track_idx",
];

const env = loadEnv();
if (!env.DATABASE_URL) {
  console.error("Missing DATABASE_URL in the environment.");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
try {
  const { rows } = await pool.query(
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1)",
    [REQUIRED]
  );
  const present = new Set(rows.map((r) => r.indexname));
  const missing = REQUIRED.filter((n) => !present.has(n));
  if (missing.length) {
    console.error(`MISSING ${missing.length} performance index(es):`);
    for (const m of missing) console.error(`  - ${m}`);
    console.error(
      "\nApply drizzle/0015_perf_indexes.sql and " +
        "drizzle/0019_audit_indexes_and_share_fk.sql by hand (see AGENTS.md)."
    );
    process.exitCode = 1;
  } else {
    console.log(`All ${REQUIRED.length} performance indexes present.`);
  }
} finally {
  await pool.end();
}
