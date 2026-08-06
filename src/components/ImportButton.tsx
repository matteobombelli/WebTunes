"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type {
  ImportJobDTO,
  ImportQuality,
  ImportSearchResultDTO,
  ImportVersionPref,
} from "@/lib/types";
import Dialog from "@/components/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { DEMO_READ_ONLY_MESSAGE } from "@/lib/demo-accounts";
import { useImportsStore, type ImportOptions } from "@/stores/imports";
import { useToastStore } from "@/stores/toast";

// In-site importer: Settings / Link / Search tabs, with the Link tab carrying
// the progress bar, live log view, and missed-tracks list.

const QUALITY_CHOICES: { value: ImportQuality; label: string }[] = [
  { value: "128", label: "128 kbps MP3" },
  { value: "192", label: "192 kbps MP3" },
  { value: "opus", label: "Best (Opus, lossless)" },
  { value: "m4a", label: "Best (.m4a, lossless)" },
];

const DEFAULT_OPTIONS: ImportOptions = {
  quality: "opus",
  strictness: 0.7,
  versionPref: "none",
};

const OPTIONS_KEY = "wt-import-options";

function loadOptions(): ImportOptions {
  try {
    const raw = localStorage.getItem(OPTIONS_KEY);
    if (raw) return { ...DEFAULT_OPTIONS, ...JSON.parse(raw) };
  } catch {
    // corrupt/unavailable localStorage - fall through to defaults
  }
  return DEFAULT_OPTIONS;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "";
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function isActive(job: ImportJobDTO): boolean {
  return (
    job.status === "queued" ||
    job.status === "resolving" ||
    job.status === "running"
  );
}

export default function ImportButton({
  readOnly = false,
}: {
  readOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          if (readOnly) {
            useToastStore.getState().show(DEMO_READ_ONLY_MESSAGE);
            return;
          }
          setOpen(true);
        }}
      >
        Import
      </Button>
      <Dialog title="Import music" open={open} onClose={() => setOpen(false)} wide>
        {open && <ImportForm />}
      </Dialog>
    </>
  );
}

function ImportForm() {
  const [tab, setTab] = useState<"settings" | "link" | "search">("link");
  // Lazy init is client-safe: this form only mounts once the dialog opens
  // (never during SSR), so localStorage is available.
  const [options, setOptions] = useState<ImportOptions>(loadOptions);

  const changeOptions = (patch: Partial<ImportOptions>) => {
    setOptions((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(OPTIONS_KEY, JSON.stringify(next));
      } catch {
        // persistence is best-effort
      }
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <SegmentedControl
        options={[
          { value: "settings", label: "Settings" },
          { value: "link", label: "Link" },
          { value: "search", label: "Search" },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "settings" && (
        <SettingsTab options={options} onChange={changeOptions} />
      )}
      {tab === "link" && <LinkTab options={options} />}
      {tab === "search" && <SearchTab options={options} />}

    </div>
  );
}

function SettingsTab({
  options,
  onChange,
}: {
  options: ImportOptions;
  onChange: (patch: Partial<ImportOptions>) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-xs text-fg-muted">
        Audio quality
        <select
          value={options.quality}
          onChange={(e) => onChange({ quality: e.target.value as ImportQuality })}
          className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-fg"
        >
          {QUALITY_CHOICES.map((q) => (
            <option key={q.value} value={q.value}>
              {q.label}
            </option>
          ))}
        </select>
      </label>

      {/* Matching options only apply to Spotify/Apple links (tracks are
          resolved to YouTube); harmless to leave set for YouTube imports. */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs text-fg-muted">
            Match strictness (Spotify/Apple)
          </span>
          <span className="text-xs text-accent-bright">
            {options.strictness.toFixed(2)}
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={options.strictness}
          onChange={(e) => onChange({ strictness: Number(e.target.value) })}
          className="w-full accent-accent"
          aria-label="Match strictness"
        />
        <div className="mt-1 flex justify-between text-[10px] text-fg-subtle">
          <span>Lenient</span>
          <span>Exact</span>
        </div>
      </div>

      <label className="flex flex-col gap-1 text-xs text-fg-muted">
        Version preference (Spotify/Apple)
        <SegmentedControl
          options={[
            { value: "none", label: "Any" },
            { value: "studio", label: "Studio" },
            { value: "live", label: "Live" },
          ]}
          value={options.versionPref}
          onChange={(versionPref: ImportVersionPref) => onChange({ versionPref })}
        />
      </label>
    </div>
  );
}

function LinkTab({ options }: { options: ImportOptions }) {
  const submit = useImportsStore((s) => s.submit);
  const submitting = useImportsStore((s) => s.submitting);
  const cancel = useImportsStore((s) => s.cancel);
  const jobs = useImportsStore((s) => s.jobs);

  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  // At most one job runs at a time (global serial worker); the rest queue
  // behind it. Show the running job's progress/log - else the newest finished
  // one - and list what's queued. Jobs arrive newest-first; the queue runs
  // oldest-first, so reverse it for display.
  const job: ImportJobDTO | undefined =
    jobs.find((j) => j.status === "resolving" || j.status === "running") ??
    jobs.find((j) => j.status !== "queued");
  const queuedJobs = jobs.filter((j) => j.status === "queued").reverse();
  const busy = !!job && isActive(job);
  const start = async () => {
    setError(null);
    try {
      await submit(url.trim(), options);
      setUrl("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    }
  };

  const items = job?.items ?? [];
  const finished = items.filter(
    (it) => it.status !== "waiting" && it.status !== "matching" &&
      it.status !== "downloading" && it.status !== "uploading"
  );
  const imported = items.filter((it) => it.status === "done").length;
  const missedItems = items.filter((it) => it.status === "missed");
  const overall = items.length === 0 ? 0 : (finished.length / items.length) * 100;

  // Auto-scroll the log to the newest line, like the desktop's log view.
  const logRef = useRef<HTMLPreElement>(null);
  const logLength = job?.log.length ?? 0;
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logLength]);

  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) void start();
        }}
      >
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Spotify, Apple Music, or YouTube link (album, playlist, or song)"
          className="flex-1"
        />
        <Button type="submit" disabled={submitting || !url.trim()}>
          {busy || queuedJobs.length > 0 ? "Queue" : "Import"}
        </Button>
      </form>
      {error && <p className="text-sm text-red-400">{error}</p>}

      {queuedJobs.length > 0 && (
        <ul className="flex flex-col gap-1">
          {queuedJobs.map((j) => (
            <li
              key={j.id}
              className="flex items-center gap-2 text-xs text-fg-muted"
            >
              <span className="min-w-0 flex-1 truncate">
                Queued: {j.sourceUrl}
              </span>
              <button
                onClick={() => void cancel(j.id)}
                className="font-medium hover:text-red-400"
              >
                Cancel
              </button>
            </li>
          ))}
        </ul>
      )}

      {job && (
        <>
          <div className="flex items-center gap-2">
            <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full bg-accent transition-[width] duration-150"
                style={{ width: `${overall}%` }}
              />
            </div>
            {busy && (
              <button
                onClick={() => void cancel(job.id)}
                className="text-xs font-medium text-fg-muted hover:text-red-400"
              >
                Cancel
              </button>
            )}
          </div>
          <p className="text-xs tabular-nums text-fg-muted">
            {imported} imported · {missedItems.length} missed · {finished.length}{" "}
            / {items.length}
          </p>
          <pre
            ref={logRef}
            className="h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-border-subtle bg-surface-2/50 p-2 font-mono text-xs text-fg-muted"
          >
            {job.log.join("\n")}
          </pre>
          {!busy && missedItems.length > 0 && (
            <div className="rounded-md border border-border-subtle p-2">
              <p className="mb-1 text-xs font-semibold text-fg">Missed tracks</p>
              <ul className="max-h-28 overflow-y-auto text-xs text-fg-muted">
                {missedItems.map((it, i) => (
                  <li key={i} className="truncate py-0.5">
                    {it.label}
                    {it.reason && ` (${it.reason})`}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SearchTab({ options }: { options: ImportOptions }) {
  const submit = useImportsStore((s) => s.submit);
  const submitting = useImportsStore((s) => s.submitting);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ImportSearchResultDTO[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Rows already sent this session, so "Import" doesn't invite double-submits.
  const [imported, setImported] = useState<Set<string>>(new Set());

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    try {
      setResults(
        await api<ImportSearchResultDTO[]>(
          `/import/search?q=${encodeURIComponent(query.trim())}`
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setSearching(false);
    }
  };

  const importRow = async (row: ImportSearchResultDTO) => {
    setError(null);
    setImported((prev) => new Set(prev).add(row.id));
    try {
      await submit(row.url, options);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
      setImported((prev) => {
        const next = new Set(prev);
        next.delete(row.id);
        return next;
      });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <form onSubmit={search} className="flex gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search YouTube…"
          className="flex-1"
        />
        <Button type="submit" disabled={searching || !query.trim()}>
          {searching ? "Searching…" : "Search"}
        </Button>
      </form>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {results && results.length === 0 && (
        <p className="text-sm text-fg-muted">No results.</p>
      )}
      {results && results.length > 0 && (
        <ul className="max-h-72 divide-y divide-border-subtle overflow-y-auto rounded-md border border-border-subtle">
          {results.map((r) => (
            <li key={r.id} className="flex items-center gap-3 p-2">
              {r.thumbnail && (
                // External YouTube thumbnail - not a Next-optimizable asset.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={r.thumbnail}
                  alt=""
                  className="h-9 w-16 shrink-0 rounded object-cover"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-fg">{r.title}</p>
                <p className="truncate text-xs text-fg-muted">
                  {r.uploader}
                  {r.duration !== null && ` · ${formatDuration(r.duration)}`}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={submitting || imported.has(r.id)}
                onClick={() => void importRow(r)}
              >
                {imported.has(r.id) ? "Queued" : "Import"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
