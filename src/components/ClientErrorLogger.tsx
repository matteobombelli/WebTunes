"use client";

import { useEffect } from "react";
import { log } from "@/lib/log";

// Render-nothing component (same shape as ServiceWorkerRegistrar) that surfaces
// otherwise-invisible uncaught client errors to the F12 console (and the
// window.__wtLog buffer). Mounted in the ROOT layout so it covers every route
// group — (app), (auth), and the public share/[token] page. These are errors,
// so they log regardless of the `wt-log` verbose flag.
export default function ClientErrorLogger() {
  useEffect(() => {
    const onError = (e: ErrorEvent) =>
      log.error("window", e.message || "uncaught error", {
        source: e.filename,
        line: e.lineno,
        col: e.colno,
        stack: e.error?.stack,
      });
    const onRejection = (e: PromiseRejectionEvent) =>
      log.error(
        "window",
        "unhandledrejection",
        e.reason instanceof Error ? e.reason.stack ?? e.reason.message : e.reason
      );
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
