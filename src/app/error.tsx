"use client";

import { useEffect } from "react";
import { log } from "@/lib/log";

// Catches render/RSC errors in every segment below the root layout — including
// (app)/layout.tsx's requirePageUser/getUserSettings. Renders inside the root
// <body>. Works in both dev and prod (global-error.tsx is the prod-only net for
// the root layout itself).
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    log.error("route-error", error.message, {
      digest: error.digest,
      stack: error.stack,
    });
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="text-fg-muted">Something went wrong loading this page.</p>
      <button
        onClick={reset}
        className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover"
      >
        Try again
      </button>
    </div>
  );
}
