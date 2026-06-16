import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

// Reuse the pool across HMR reloads in dev to avoid exhausting connections.
const globalForDb = globalThis as unknown as { webtunesPool?: Pool };

const pool =
  globalForDb.webtunesPool ??
  new Pool({ connectionString: process.env.DATABASE_URL, max: 25 });

if (process.env.NODE_ENV !== "production") globalForDb.webtunesPool = pool;

export const db = drizzle(pool, { schema });

/**
 * True when an error is (or wraps) a Postgres unique-constraint violation,
 * so check-then-insert flows can return their friendly 409 instead of a 500
 * when two requests race past the check.
 */
export function isUniqueViolation(err: unknown): boolean {
  while (typeof err === "object" && err !== null) {
    if ((err as { code?: unknown }).code === "23505") return true;
    err = (err as { cause?: unknown }).cause;
  }
  return false;
}
