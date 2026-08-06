import type { PoolClient } from "pg";
import { dbPool } from "@/db";

export type ImportLanePriority = "manual" | "suggested";

type Waiting<T> = {
  priority: ImportLanePriority;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

// Stable signed 32-bit advisory-lock key. The database lock extends the
// single-process queue across stale/overlapping Next server processes during a
// deploy, while the local priority queue lets user-started imports jump ahead
// of background suggestions between yt-dlp commands.
const YTDLP_LOCK_KEY = 0x57545954;
const waiting: Waiting<unknown>[] = [];
let draining = false;

export function withYtDlpLane<T>(
  priority: ImportLanePriority,
  run: () => Promise<T>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    waiting.push({ priority, run, resolve, reject } as Waiting<unknown>);
    void drain();
  });
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (waiting.length) {
      const manual = waiting.findIndex((item) => item.priority === "manual");
      const [item] = waiting.splice(manual >= 0 ? manual : 0, 1);
      let client: PoolClient;
      try {
        client = await dbPool.connect();
      } catch (error) {
        // The item has already left the queue, so a failed pool checkout must
        // reject its promise here rather than leave the caller waiting forever.
        item.reject(error);
        continue;
      }

      let lockAcquired = false;
      let destroyClient = false;
      try {
        await client.query("select pg_advisory_lock($1)", [YTDLP_LOCK_KEY]);
        lockAcquired = true;
        item.resolve(await item.run());
      } catch (error) {
        item.reject(error);
      } finally {
        if (lockAcquired) {
          try {
            const result = await client.query<{ unlocked: boolean }>(
              "select pg_advisory_unlock($1) as unlocked",
              [YTDLP_LOCK_KEY]
            );
            destroyClient = result.rows[0]?.unlocked !== true;
          } catch {
            destroyClient = true;
          }
        } else {
          // A failed lock query has an ambiguous server-side outcome. Never put
          // that session back in the pool where a leaked advisory lock could
          // outlive this work item; destroying it releases all session locks.
          destroyClient = true;
        }
        client.release(destroyClient);
      }
    }
  } finally {
    draining = false;
    if (waiting.length) void drain();
  }
}
