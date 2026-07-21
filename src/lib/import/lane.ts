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
      const client = await dbPool.connect();
      try {
        await client.query("select pg_advisory_lock($1)", [YTDLP_LOCK_KEY]);
        item.resolve(await item.run());
      } catch (error) {
        item.reject(error);
      } finally {
        await client
          .query("select pg_advisory_unlock($1)", [YTDLP_LOCK_KEY])
          .catch(() => {});
        client.release();
      }
    }
  } finally {
    draining = false;
    if (waiting.length) void drain();
  }
}
