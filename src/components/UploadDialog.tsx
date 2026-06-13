"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { BASE_PATH } from "@/lib/base-path";
import { CheckIcon, XIcon } from "@/components/icons";

type UploadItem = {
  name: string;
  status: "uploading" | "done" | "error";
  progress: number; // 0–100, bytes sent for the current file
  detail?: string;
};

// XMLHttpRequest (not fetch) is the only browser API that reports upload
// progress, so the per-file POST is sent through it here.
function uploadFile(
  file: File,
  onProgress: (percent: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BASE_PATH}/api/tracks`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress((e.loaded / e.total) * 100);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      let message = `Upload failed (${xhr.status})`;
      try {
        const data = JSON.parse(xhr.responseText);
        if (typeof data?.error === "string") message = data.error;
      } catch {
        // non-JSON error body
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.send(form);
  });
}

export default function UploadDialog() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [busy, setBusy] = useState(false);

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setItems(
      Array.from(files).map((f) => ({
        name: f.name,
        status: "uploading",
        progress: 0,
      }))
    );

    for (const [i, file] of Array.from(files).entries()) {
      try {
        await uploadFile(file, (percent) =>
          setItems((prev) =>
            prev.map((it, j) => (j === i ? { ...it, progress: percent } : it))
          )
        );
        setItems((prev) =>
          prev.map((it, j) =>
            j === i ? { ...it, status: "done", progress: 100 } : it
          )
        );
      } catch (err) {
        setItems((prev) =>
          prev.map((it, j) =>
            j === i
              ? {
                  ...it,
                  status: "error",
                  detail: err instanceof Error ? err.message : "failed",
                }
              : it
          )
        );
      }
    }
    setBusy(false);
    router.refresh();
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <input
        ref={inputRef}
        type="file"
        accept="audio/*,.mp3,.m4a,.flac,.ogg,.opus,.wav"
        multiple
        hidden
        onChange={(e) => onFiles(e.target.files)}
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
            <span className="tabular-nums">
              {items.filter((it) => it.status !== "uploading").length}/
              {items.length}
            </span>
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
                  <span className="truncate">{it.name}</span>
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
