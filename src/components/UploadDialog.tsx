"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { CheckIcon, XIcon } from "@/components/icons";
import { useUploadsStore } from "@/stores/uploads";

export default function UploadDialog() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const items = useUploadsStore((s) => s.items);
  const busy = useUploadsStore((s) => s.busy);
  const start = useUploadsStore((s) => s.start);
  const cancel = useUploadsStore((s) => s.cancel);
  const clear = useUploadsStore((s) => s.clear);

  // Refresh the server-rendered library list once a batch finishes. Lives here
  // (not in the store) because only a mounted page can call the router; if the
  // user is elsewhere when it finishes, navigating back refetches anyway.
  const prevBusy = useRef(busy);
  useEffect(() => {
    if (prevBusy.current && !busy) router.refresh();
    prevBusy.current = busy;
  }, [busy, router]);

  const done = items.filter((it) => it.status !== "uploading").length;

  return (
    <div className="flex flex-col items-end gap-2">
      <input
        ref={inputRef}
        type="file"
        accept="audio/*,.mp3,.m4a,.flac,.ogg,.opus,.wav"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) start(Array.from(e.target.files));
          e.target.value = ""; // allow re-selecting the same file
        }}
      />
      <button
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
      >
        {busy ? "Uploading…" : "Upload music"}
      </button>
      {items.length > 0 && (
        <div className="w-64 rounded-md border border-neutral-800 bg-neutral-900/90 text-xs text-neutral-400 shadow-lg">
          <div className="flex items-center justify-between border-b border-neutral-800 px-2.5 py-1.5 font-medium text-neutral-300">
            <span>{busy ? "Uploading…" : "Uploads"}</span>
            <div className="flex items-center gap-2">
              <span className="tabular-nums">
                {done}/{items.length}
              </span>
              {busy ? (
                <button
                  onClick={cancel}
                  className="font-medium text-neutral-400 hover:text-red-400"
                >
                  Cancel
                </button>
              ) : (
                <button
                  onClick={clear}
                  aria-label="Dismiss"
                  className="text-neutral-500 hover:text-white"
                >
                  <XIcon size={13} />
                </button>
              )}
            </div>
          </div>
          <ul className="max-h-64 space-y-1 overflow-y-auto p-2.5">
            {items.map((it, i) => (
              <li key={i}>
                <div className="flex items-center gap-1.5">
                  {it.status === "done" && (
                    <CheckIcon size={13} className="shrink-0 text-emerald-400" />
                  )}
                  {it.status === "error" && (
                    <XIcon size={13} className="shrink-0 text-red-400" />
                  )}
                  {it.status === "canceled" && (
                    <XIcon size={13} className="shrink-0 text-neutral-500" />
                  )}
                  <span
                    className={`truncate ${it.status === "canceled" ? "text-neutral-500 line-through" : ""}`}
                  >
                    {it.name}
                  </span>
                </div>
                {it.status === "uploading" && (
                  <div className="mt-0.5 h-1 w-full overflow-hidden rounded bg-neutral-800">
                    <div
                      className="h-full rounded bg-emerald-500 transition-[width] duration-100"
                      style={{ width: `${it.progress}%` }}
                    />
                  </div>
                )}
                {it.detail ? (
                  <span className="text-red-400/80">{it.detail}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
