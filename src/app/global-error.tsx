"use client";

import { useEffect } from "react";
import { log } from "@/lib/log";

// Last-resort net for errors thrown in the root layout itself. It replaces the
// root layout, so it must render its own <html>/<body>. Active in production
// only (the dev overlay shows instead).
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    log.error("global-error", error.message, {
      digest: error.digest,
      stack: error.stack,
    });
  }, [error]);

  return (
    <html lang="en">
      <body className="flex min-h-screen items-center justify-center bg-surface-0 text-fg">
        <div className="text-center">
          <p className="mb-4 text-fg-muted">Something went wrong.</p>
          <button
            onClick={reset}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
