// Daily cleanup of MCP/OAuth state, run by deploy/webtunes-purge-mcp.timer:
// - mcp_actions older than the 30-day undo window (MCP_UNDO_WINDOW_DAYS in
//   src/lib/mcp/actions.ts; undo already refuses them, this bounds the table)
// - expired authorization codes and access/refresh tokens
// - grants left with no live token (every refresh token expired or was
//   revoked), then registered clients no grant references. The one-day grace
//   keeps a grant whose code is mid-exchange and a client mid-authorization.
//   node scripts/purge-mcp-state.mjs
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

const purges = [
  ["undo-log action(s)", "DELETE FROM mcp_actions WHERE created_at < now() - interval '30 days'"],
  ["expired authorization code(s)", "DELETE FROM oauth_codes WHERE expires_at < now()"],
  ["expired token(s)", "DELETE FROM oauth_tokens WHERE expires_at < now()"],
  [
    "dead grant(s)",
    `DELETE FROM oauth_grants g
      WHERE g.created_at < now() - interval '1 day'
        AND NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = g.id)`,
  ],
  [
    "unused client registration(s)",
    `DELETE FROM oauth_clients c
      WHERE c.created_at < now() - interval '1 day'
        AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.id)`,
  ],
];

for (const [label, query] of purges) {
  const { rowCount } = await pool.query(query);
  console.log(`Purged ${rowCount} ${label}.`);
}

await pool.end();
