import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

// Reuse the pool across HMR reloads in dev to avoid exhausting connections.
const globalForDb = globalThis as unknown as { webtunesPool?: Pool };

const pool =
  globalForDb.webtunesPool ??
  new Pool({ connectionString: process.env.DATABASE_URL });

if (process.env.NODE_ENV !== "production") globalForDb.webtunesPool = pool;

export const db = drizzle(pool, { schema });
