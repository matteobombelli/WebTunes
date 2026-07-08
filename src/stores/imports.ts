"use client";

import { create } from "zustand";
import { api } from "@/lib/api";
import { log } from "@/lib/log";
import type {
  ImportJobDTO,
  ImportQuality,
  ImportVersionPref,
} from "@/lib/types";

// Import-job state, mirroring the uploads store: module-level so an in-flight
// import (and its results) stays visible across client-side navigation. Unlike
// uploads, the job itself runs SERVER-side — this store just polls
// GET /api/import while anything is active, so a reload mid-import re-attaches
// to the running job on the next hydrate().

export type ImportOptions = {
  quality: ImportQuality;
  strictness: number;
  versionPref: ImportVersionPref;
};

type ImportsState = {
  jobs: ImportJobDTO[];
  /** True while a submit request is in flight (before the job shows up). */
  submitting: boolean;
  /** Fetch current jobs once and start polling if any are active. */
  hydrate: () => void;
  /** Submit a URL for import. Resolves once the job is accepted; throws with
   * the server's message (400 bad URL / 409 already running) otherwise. */
  submit: (url: string, opts: ImportOptions) => Promise<void>;
  cancel: (jobId: string) => Promise<void>;
  /** Dismisses finished jobs from the progress bar. */
  clear: () => void;
};

function isActive(job: ImportJobDTO): boolean {
  return job.status === "resolving" || job.status === "running";
}

// Module-level like uploads' activeXhrs: one poll loop no matter how many
// components subscribe, surviving navigation. Dismissed job ids are hidden
// from `jobs` until the server prunes them (1 h retention).
let pollTimer: ReturnType<typeof setInterval> | null = null;
const dismissed = new Set<string>();
const POLL_MS = 2000;

export const useImportsStore = create<ImportsState>((set, get) => {
  async function refresh(): Promise<void> {
    let jobs: ImportJobDTO[];
    try {
      jobs = await api<ImportJobDTO[]>("/import");
    } catch {
      return; // transient poll failure — keep the last snapshot
    }
    set({ jobs: jobs.filter((j) => !dismissed.has(j.id)) });
    if (!jobs.some(isActive)) stopPolling();
  }

  function startPolling(): void {
    if (pollTimer) return;
    pollTimer = setInterval(() => void refresh(), POLL_MS);
  }

  function stopPolling(): void {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  return {
    jobs: [],
    submitting: false,

    hydrate: () => {
      void (async () => {
        // Jobs already terminal when the page loads are old news — dismiss
        // them so a finished (or failed) job doesn't greet every app open for
        // the rest of its server-side retention. Active jobs re-attach and
        // show their results when they finish.
        let jobs: ImportJobDTO[];
        try {
          jobs = await api<ImportJobDTO[]>("/import");
        } catch {
          return;
        }
        for (const job of jobs) {
          if (!isActive(job)) dismissed.add(job.id);
        }
        set({ jobs: jobs.filter((j) => !dismissed.has(j.id)) });
        if (jobs.some(isActive)) startPolling();
      })();
    },

    submit: async (url, opts) => {
      set({ submitting: true });
      try {
        await api("/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, ...opts }),
        });
        log.info("import", `submitted ${url.slice(0, 200)}`);
        await refresh();
        startPolling();
      } finally {
        set({ submitting: false });
      }
    },

    cancel: async (jobId) => {
      try {
        await api(`/import/${jobId}/cancel`, { method: "POST" });
      } catch (err) {
        log.warn(
          "import",
          `cancel failed ${jobId}`,
          err instanceof Error ? err.message : String(err)
        );
      }
      void refresh();
    },

    clear: () => {
      for (const job of get().jobs) {
        if (!isActive(job)) dismissed.add(job.id);
      }
      set({ jobs: get().jobs.filter(isActive) });
    },
  };
});
