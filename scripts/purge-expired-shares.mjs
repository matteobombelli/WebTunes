// Deletes expired public track-share links (track_shares.expires_at < now()) so
// they don't accumulate. Run daily by deploy/webtunes-purge-shares.timer.
// Expired rows are already inert (lib/shares.ts filters by expiry and the
// upsert self-heals same-track collisions); this is the guarantee they're gone.
//   node scripts/purge-expired-shares.mjs
// DATABASE_URL comes from the process environment when set, otherwise the first
// env file present.
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
  let env = { ...process.env };
  for (const f of ENV_FILES) {
    const path = join(root, f);
    if (existsSync(path)) env = { ...env, ...parseEnvFile(path) };
  }
  return env;
}

const env = loadEnv();
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

const { rowCount } = await pool.query(
  "DELETE FROM track_shares WHERE expires_at < now()"
);
console.log(`Purged ${rowCount} expired share link(s).`);

await pool.end();
