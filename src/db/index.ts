import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

// Reuse the pool across HMR reloads in dev to avoid exhausting connections.
const globalForDb = globalThis as unknown as { webtunesPool?: Pool };

const pool =
  globalForDb.webtunesPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 25,
    // Disable JIT pool-wide. Queries whose *estimated* cost crosses Postgres's
    // jit_above_cost (notably scope=all/search, inflated by the dedup subplan)
    // otherwise spend ~400ms compiling machine code to speed up a query that
    // runs in single-digit ms — at this data scale JIT is pure overhead.
    options: "-c jit=off",
  });

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
