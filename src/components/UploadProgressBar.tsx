"use client";

import { XIcon } from "@/components/icons";
import { useUploadsStore } from "@/stores/uploads";

// A single slim bar pinned across the top of the app while an upload batch is
// running (or waiting to be dismissed). Lives in the app layout so it survives
// client-side navigation, replacing the old floating per-file dialog.
export default function UploadProgressBar() {
  const items = useUploadsStore((s) => s.items);
  const busy = useUploadsStore((s) => s.busy);
  const cancel = useUploadsStore((s) => s.cancel);
  const clear = useUploadsStore((s) => s.clear);

  if (items.length === 0) return null;

  const done = items.filter((it) => it.status !== "uploading").length;
  const duplicates = items.filter((it) => it.status === "duplicate").length;
  const failed = items.filter((it) => it.status === "error").length;
  const overall = items.reduce((sum, it) => sum + it.progress, 0) / items.length;

  return (
    <div className="relative h-9 shrink-0 overflow-hidden border-b border-neutral-800 bg-neutral-900">
      <div
        className="absolute inset-y-0 left-0 bg-emerald-600/30 transition-[width] duration-150"
        style={{ width: `${overall}%` }}
      />
      <div className="relative flex h-full items-center gap-3 px-4 text-sm">
        <span className="font-medium text-neutral-200">
          {busy ? "Uploading…" : "Uploaded"}
        </span>
        <span className="tabular-nums text-neutral-400">
          {done}/{items.length}
          {duplicates > 0 && (
            <span className="text-yellow-400">
              {" "}
              · {duplicates} duplicate{duplicates === 1 ? "" : "s"}
            </span>
          )}
          {failed > 0 && <span className="text-red-400"> · {failed} failed</span>}
        </span>
        <div className="ml-auto">
          {busy ? (
            <button
              onClick={cancel}
              className="text-xs font-medium text-neutral-400 hover:text-red-400"
            >
              Cancel
            </button>
          ) : (
            <button
              onClick={clear}
              aria-label="Dismiss"
              className="text-neutral-500 hover:text-white"
            >
              <XIcon size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
