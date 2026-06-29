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
    // Two pool-wide GUCs:
    // - jit=off: queries whose *estimated* cost crosses Postgres's jit_above_cost
    //   (notably scope=all/search, inflated by the dedup subplan) otherwise spend
    //   ~400ms compiling machine code to speed up a query that runs in single-digit
    //   ms — at this data scale JIT is pure overhead.
    // - hnsw.iterative_scan=relaxed_order: "play similar"/Discover rank an HNSW
    //   vector index UNDER restrictive WHERE filters (access rule + exclusions +
    //   dedup). Plain HNSW explores only ef_search (~40) nodes, then the filters
    //   drop most — so a seed whose acoustic neighbours are mostly inaccessible
    //   returned as few as 4 of the requested 10. Iterative scan keeps resuming
    //   the index until the LIMIT (POOL_SIZE) is filled; relaxed_order is fine
    //   since we re-score and Gumbel-sample the pool anyway. Only affects HNSW
    //   scans, so it's inert for every non-vector query.
    options: "-c jit=off -c hnsw.iterative_scan=relaxed_order",
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

/**
 * The constraint/index name of a unique violation (23505), or null when the
 * error isn't one. Lets a flow that can trip more than one unique constraint
 * (registration: both email and username are unique) tell which one collided —
 * Postgres reports the index name for unique-index violations.
 */
export function uniqueViolationConstraint(err: unknown): string | null {
  while (typeof err === "object" && err !== null) {
    if ((err as { code?: unknown }).code === "23505") {
      const name = (err as { constraint?: unknown }).constraint;
      return typeof name === "string" ? name : "";
    }
    err = (err as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * True when an error is (or wraps) a Postgres foreign-key violation (23503),
 * so an insert referencing a row that doesn't exist (e.g. a stale track id)
 * can return a 404 instead of a 500.
 */
export function isForeignKeyViolation(err: unknown): boolean {
  while (typeof err === "object" && err !== null) {
    if ((err as { code?: unknown }).code === "23503") return true;
    err = (err as { cause?: unknown }).cause;
  }
  return false;
}
