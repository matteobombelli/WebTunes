"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { BASE_PATH } from "@/lib/base-path";

type UploadItem = { name: string; status: "uploading" | "done" | "error"; detail?: string };

export default function UploadDialog() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [busy, setBusy] = useState(false);

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setItems(Array.from(files).map((f) => ({ name: f.name, status: "uploading" })));

    for (const [i, file] of Array.from(files).entries()) {
      const form = new FormData();
      form.append("file", file);
      try {
        const res = await fetch(`${BASE_PATH}/api/tracks`, {
          method: "POST",
          body: form,
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error ?? `Upload failed (${res.status})`);
        }
        setItems((prev) =>
          prev.map((it, j) => (j === i ? { ...it, status: "done" } : it))
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
        <ul className="text-xs text-neutral-400">
          {items.map((it, i) => (
            <li key={i}>
              {it.status === "uploading" && "⏳ "}
              {it.status === "done" && <span className="text-emerald-400">✓ </span>}
              {it.status === "error" && <span className="text-red-400">✕ </span>}
              {it.name}
              {it.detail ? ` (${it.detail})` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
