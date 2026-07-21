"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, PlayIcon, XIcon } from "@/components/icons";
import TrackArt from "@/components/TrackArt";
import { sectionHeadingClass } from "@/components/DiscoverSection";
import { api } from "@/lib/api";
import type {
  SuggestedImportPoolDTO,
  TrackDTO,
} from "@/lib/types";
import { useCurrentTrack, usePlayerStore } from "@/stores/player";
import { useToastStore } from "@/stores/toast";

export default function SuggestedImportsSection({
  initialPool,
}: {
  initialPool: SuggestedImportPoolDTO;
}) {
  const [pool, setPool] = useState(initialPool);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const current = useCurrentTrack();
  const router = useRouter();

  useEffect(() => {
    if (
      pool.blockedReason ||
      (pool.items.length >= pool.target && pool.processing === 0)
    ) {
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await api<SuggestedImportPoolDTO>("/suggested-imports");
        if (!cancelled) setPool(next);
      } catch {
        // The normal API logger captures this; keep the last playable pool.
      }
    };
    const timer = window.setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pool.blockedReason, pool.items.length, pool.processing, pool.target]);

  const mutate = async (id: string, action: "accept" | "reject") => {
    if (busy.has(id)) return;
    const item = pool.items.find((candidate) => candidate.id === id);
    if (!item) return;
    setBusy((old) => new Set(old).add(id));
    try {
      const promoted = await api<TrackDTO | undefined>(
        `/suggested-imports/${id}/${action}`,
        {
        method: "POST",
        }
      );
      if (action === "reject") {
        usePlayerStore.getState().removeTrackEverywhere(item.track.id);
      } else if (promoted) {
        usePlayerStore.getState().replaceTrackEverywhere(promoted);
      }
      setPool((old) => ({
        ...old,
        items: old.items.filter((candidate) => candidate.id !== id),
        processing: old.processing + 1,
        blockedReason: null,
      }));
      router.refresh();
    } catch {
      useToastStore
        .getState()
        .show(`Couldn’t ${action} “${item.track.title}”`);
    } finally {
      setBusy((old) => {
        const next = new Set(old);
        next.delete(id);
        return next;
      });
    }
  };

  const emptyMessage =
    pool.blockedReason === "no_key"
      ? "AcoustID identification is not configured yet."
      : pool.blockedReason === "no_seeds"
        ? "Listen to or add a few identifiable tracks to build your suggestions."
        : "Finding and importing your first suggestions…";

  return (
    <section>
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h2 className={sectionHeadingClass}>Suggested imports</h2>
          <p className="mt-1 text-xs text-fg-muted">
            Preview them now. Keep what you love, reject what you don’t.
          </p>
        </div>
        <span className="shrink-0 text-xs text-fg-subtle">
          {pool.items.length}/{pool.target}
          {(pool.processing > 0 || pool.items.length < pool.target) &&
            !pool.blockedReason &&
            " · refilling"}
        </span>
      </div>

      {pool.items.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface-1 px-4 py-6 text-center text-sm text-fg-muted">
          {emptyMessage}
        </div>
      ) : (
        <div className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-2">
          {pool.items.map((item) => {
            const pending = busy.has(item.id);
            return (
              <article
                key={item.id}
                className="w-40 shrink-0 snap-start overflow-hidden rounded-xl border border-border bg-surface-1 sm:w-48"
              >
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    usePlayerStore
                      .getState()
                      .playQueue([item.track], 0, { noAutoSimilar: true })
                  }
                  className={`group relative block aspect-square w-full overflow-hidden bg-surface-2 ${
                    current?.id === item.track.id ? "ring-2 ring-inset ring-accent" : ""
                  }`}
                  aria-label={`Play ${item.track.title}`}
                >
                  <TrackArt track={item.track} size="h-full w-full" iconSize={32} />
                  <span className="absolute inset-0 flex items-center justify-center bg-black/0 transition group-hover:bg-black/35">
                    <span className="rounded-full bg-black/65 p-2 text-white opacity-0 transition group-hover:opacity-100">
                      <PlayIcon size={20} />
                    </span>
                  </span>
                </button>
                <div className="p-3">
                  <p className="truncate text-sm font-semibold" title={item.track.title}>
                    {item.track.title}
                  </p>
                  <p className="truncate text-xs text-fg-muted">
                    {item.track.artist ?? "Unknown artist"}
                  </p>
                  {item.reason && (
                    <p className="mt-1 truncate text-[0.68rem] text-fg-subtle">
                      {item.reason}
                    </p>
                  )}
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => void mutate(item.id, "accept")}
                      className="flex items-center justify-center gap-1 rounded-md bg-accent px-2 py-2 text-xs font-semibold text-accent-fg transition hover:bg-accent-hover disabled:opacity-50"
                      aria-label={`Keep ${item.track.title}`}
                    >
                      <CheckIcon className="h-4 w-4" /> Keep
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => void mutate(item.id, "reject")}
                      className="flex items-center justify-center gap-1 rounded-md border border-border px-2 py-2 text-xs font-semibold text-fg-muted transition hover:border-red-400/60 hover:text-red-400 disabled:opacity-50"
                      aria-label={`Reject ${item.track.title}`}
                    >
                      <XIcon className="h-4 w-4" /> Reject
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
          {Array.from({
            length: Math.min(
              3,
              Math.max(0, pool.target - pool.items.length)
            ),
          }).map((_, index) => (
            <div
              key={`refill-${index}`}
              className="w-40 shrink-0 snap-start animate-pulse rounded-xl border border-border bg-surface-1 p-3 sm:w-48"
            >
              <div className="aspect-square rounded-lg bg-surface-3" />
              <div className="mt-3 h-4 w-3/4 rounded bg-surface-3" />
              <div className="mt-2 h-3 w-1/2 rounded bg-surface-3" />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
