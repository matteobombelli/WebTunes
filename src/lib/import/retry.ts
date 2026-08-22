export type YtDlpRetry = {
  status: 403 | 429;
  delayMs: number;
  retry: number;
  maxRetries: number;
};

type RetryOptions = {
  signal: AbortSignal;
  onRetry?: (retry: YtDlpRetry) => void | Promise<void>;
};

const RATE_LIMIT_COOLDOWN_MS = 60_000;
const MAX_RATE_LIMIT_RETRIES = 3;
const FORBIDDEN_BACKOFF_MS = 5_000;
const MAX_FORBIDDEN_RETRIES = 2;

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function retryFor(error: unknown, attempt: number): YtDlpRetry | null {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("429") || message.includes("too many requests")) {
    if (attempt >= MAX_RATE_LIMIT_RETRIES) return null;
    return {
      status: 429,
      delayMs: RATE_LIMIT_COOLDOWN_MS,
      retry: attempt + 1,
      maxRetries: MAX_RATE_LIMIT_RETRIES,
    };
  }
  if (message.includes("403") || message.includes("forbidden")) {
    if (attempt >= MAX_FORBIDDEN_RETRIES) return null;
    return {
      status: 403,
      // A fresh yt-dlp process re-extracts the signed media URL. Brief pacing
      // keeps a transient GVS rejection from becoming a burst of failures.
      delayMs: FORBIDDEN_BACKOFF_MS * (attempt + 1),
      retry: attempt + 1,
      maxRetries: MAX_FORBIDDEN_RETRIES,
    };
  }
  return null;
}

export async function withYtDlpRetry<T>(
  run: () => Promise<T>,
  opts: RetryOptions
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const retry = retryFor(error, attempt);
      if (!retry) throw error;
      await opts.onRetry?.(retry);
      await abortableSleep(retry.delayMs, opts.signal);
    }
  }
}
