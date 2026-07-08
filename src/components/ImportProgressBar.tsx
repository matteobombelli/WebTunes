"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { XIcon } from "@/components/icons";
import type { ImportJobDTO } from "@/lib/types";
import { useImportsStore } from "@/stores/imports";

// Sibling of UploadProgressBar for server-side import jobs. Lives in the app
// layout so it survives navigation; hydrate() re-attaches to a running job
// after a reload (the job itself lives server-side).

function isActive(job: ImportJobDTO): boolean {
  return job.status === "resolving" || job.status === "running";
}

export default function ImportProgressBar() {
  const router = useRouter();
  const jobs = useImportsStore((s) => s.jobs);
  const hydrate = useImportsStore((s) => s.hydrate);
  const cancel = useImportsStore((s) => s.cancel);
  const clear = useImportsStore((s) => s.clear);
  const [showMissed, setShowMissed] = useState(false);

  useEffect(() => hydrate(), [hydrate]);

  // Refresh the server-rendered library once all jobs finish, like UploadButton.
  const busy = jobs.some(isActive);
  const prevBusy = useRef(busy);
  useEffect(() => {
    if (prevBusy.current && !busy) router.refresh();
    prevBusy.current = busy;
  }, [busy, router]);

  if (jobs.length === 0) return null;

  const items = jobs.flatMap((j) => j.items);
  const finished = items.filter(
    (it) => it.status !== "waiting" && it.status !== "matching" &&
      it.status !== "downloading" && it.status !== "uploading"
  );
  const duplicates = items.filter((it) => it.status === "duplicate").length;
  const missedItems = items.filter((it) => it.status === "missed");
  const erroredJobs = jobs.filter((j) => j.status === "error");
  const resolving = busy && items.length === 0;
  const overall =
    items.length === 0 ? 0 : (finished.length / items.length) * 100;

  return (
    <div className="shrink-0 border-b border-border-subtle bg-surface-1">
      <div className="relative h-9 overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 bg-accent/30 transition-[width] duration-150"
          style={{ width: `${overall}%` }}
        />
        <div className="relative flex h-full items-center gap-3 px-4 text-sm">
          <span className="font-medium text-fg">
            {busy ? "Importing…" : "Imported"}
          </span>
          <span className="tabular-nums text-fg-muted">
            {resolving ? (
              "finding tracks…"
            ) : (
              <>
                {finished.length}/{items.length}
                {duplicates > 0 && (
                  <span className="text-amber-300">
                    {" "}
                    · {duplicates} duplicate{duplicates === 1 ? "" : "s"}
                  </span>
                )}
                {missedItems.length > 0 && (
                  <button
                    onClick={() => setShowMissed((v) => !v)}
                    className="text-red-400 hover:underline"
                  >
                    {" "}
                    · {missedItems.length} missed
                  </button>
                )}
              </>
            )}
            {erroredJobs.length > 0 && (
              <span className="text-red-400"> · {erroredJobs[0].error}</span>
            )}
          </span>
          <div className="ml-auto">
            {busy ? (
              <button
                onClick={() => {
                  for (const job of jobs) {
                    if (isActive(job)) void cancel(job.id);
                  }
                }}
                className="text-xs font-medium text-fg-muted hover:text-red-400"
              >
                Cancel
              </button>
            ) : (
              <button
                onClick={() => {
                  setShowMissed(false);
                  clear();
                }}
                aria-label="Dismiss"
                className="text-fg-subtle hover:text-fg"
              >
                <XIcon size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
      {showMissed && missedItems.length > 0 && (
        <ul className="max-h-40 overflow-y-auto border-t border-border-subtle px-4 py-2 text-xs text-fg-muted">
          {missedItems.map((it, i) => (
            <li key={i} className="truncate py-0.5">
              <span className="text-fg">{it.label}</span>
              {it.reason && <span> — {it.reason}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
