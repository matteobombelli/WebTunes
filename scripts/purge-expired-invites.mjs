// Deletes expired-but-never-used invite links (invites.used_at IS NULL AND
// expires_at < now()) so dead links don't accumulate. Run daily by
// deploy/webtunes-purge-invites.timer. REDEEMED invites are kept on purpose —
// they're the "used by <name>" history shown on the Invite tab (the friendship
// itself is the durable record, but the row records how it formed). Expired
// unused rows are already inert (lib/invites.ts filters by used_at + expiry);
// this is the guarantee they're gone.
//   node scripts/purge-expired-invites.mjs
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
  "DELETE FROM invites WHERE used_at IS NULL AND expires_at < now()"
);
console.log(`Purged ${rowCount} expired unused invite link(s).`);

await pool.end();
