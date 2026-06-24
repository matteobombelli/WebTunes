"use client";

import { create } from "zustand";
import { BASE_PATH } from "@/lib/base-path";

export type UploadItem = {
  name: string;
  status: "uploading" | "done" | "duplicate" | "error" | "canceled";
  progress: number; // 0–100, bytes sent for the current file
  detail?: string;
};

// Thrown when the server rejects a file as already in the library (409), so the
// batch can count it as a duplicate rather than a real failure.
class DuplicateError extends Error {}

type UploadsState = {
  items: UploadItem[];
  busy: boolean;
  /** Starts a batch (no-op while one is already running). */
  start: (files: File[]) => void;
  /** Aborts the in-flight upload and skips any remaining files. */
  cancel: () => void;
  /** Dismisses a finished batch's results. */
  clear: () => void;
};

// Module-level so cancel() can abort every in-flight request from anywhere.
const activeXhrs = new Set<XMLHttpRequest>();
let canceled = false;

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
    activeXhrs.add(xhr);
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
      reject(
        xhr.status === 409 ? new DuplicateError(message) : new Error(message)
      );
    };
    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.onabort = () => reject(new Error("Canceled"));
    xhr.onloadend = () => {
      activeXhrs.delete(xhr);
    };
    xhr.send(form);
  });
}

// Module-level store: survives client-side navigation, so an in-flight batch
// (and its results) stays visible when you leave the library and come back.
export const useUploadsStore = create<UploadsState>((set, get) => ({
  items: [],
  busy: false,

  start: (files) => {
    if (get().busy || files.length === 0) return;
    canceled = false;
    set({
      busy: true,
      items: files.map((f) => ({
        name: f.name,
        status: "uploading",
        progress: 0,
      })),
    });

    // A small pool of workers each pulls the next file off a shared cursor as
    // soon as it finishes one, so up to CONCURRENCY uploads run at a time.
    const CONCURRENCY = 3;

    void (async () => {
      let next = 0;
      const worker = async () => {
        while (true) {
          const i = next++;
          if (i >= files.length || canceled) break;
          const file = files[i];
          try {
            await uploadFile(file, (percent) =>
              set((s) => ({
                items: s.items.map((it, j) =>
                  j === i ? { ...it, progress: percent } : it
                ),
              }))
            );
            set((s) => ({
              items: s.items.map((it, j) =>
                j === i ? { ...it, status: "done", progress: 100 } : it
              ),
            }));
          } catch (err) {
            set((s) => ({
              items: s.items.map((it, j) =>
                j === i
                  ? canceled
                    ? { ...it, status: "canceled" }
                    : {
                        ...it,
                        status:
                          err instanceof DuplicateError ? "duplicate" : "error",
                        detail: err instanceof Error ? err.message : "failed",
                      }
                  : it
              ),
            }));
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker)
      );

      // Mark any files we never got to (and aborted ones) as canceled.
      if (canceled) {
        set((s) => ({
          items: s.items.map((it) =>
            it.status === "uploading" ? { ...it, status: "canceled" } : it
          ),
        }));
      }
      set({ busy: false });
    })();
  },

  cancel: () => {
    if (!get().busy) return;
    canceled = true;
    for (const xhr of activeXhrs) xhr.abort();
  },

  clear: () => {
    if (get().busy) return;
    set({ items: [] });
  },
}));
