"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PlayIcon,
  XIcon,
} from "@/components/icons";
import TrackArt from "@/components/TrackArt";
import MobileSwipeTrack from "@/components/MobileSwipeAction";
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
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const carouselRef = useRef<HTMLDivElement>(null);
  const current = useCurrentTrack();
  const router = useRouter();

  const updateScrollControls = useCallback(() => {
    const carousel = carouselRef.current;
    if (!carousel) return;

    setCanScrollLeft(carousel.scrollLeft > 1);
    setCanScrollRight(
      carousel.scrollLeft + carousel.clientWidth < carousel.scrollWidth - 1
    );
  }, []);

  useEffect(() => {
    const carousel = carouselRef.current;
    if (!carousel) return;

    updateScrollControls();
    const resizeObserver = new ResizeObserver(updateScrollControls);
    resizeObserver.observe(carousel);
    window.addEventListener("resize", updateScrollControls);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateScrollControls);
    };
  }, [pool.items.length, updateScrollControls]);

  const scrollCarousel = (direction: -1 | 1) => {
    const carousel = carouselRef.current;
    if (!carousel) return;

    carousel.scrollBy({
      left: direction * Math.max(carousel.clientWidth * 0.8, 192),
      behavior: "smooth",
    });
  };

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
      ? "ListenBrainz identity lookup is not configured yet."
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
        <div className="flex shrink-0 items-center gap-3">
          <span className="text-xs text-fg-subtle">
            {pool.items.length}/{pool.target}
            {(pool.processing > 0 || pool.items.length < pool.target) &&
              !pool.blockedReason &&
              " · refilling"}
          </span>
          {pool.items.length > 0 && (
            <div className="hidden items-center gap-1 md:flex">
              <button
                type="button"
                onClick={() => scrollCarousel(-1)}
                disabled={!canScrollLeft}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface-1 text-fg-muted transition hover:border-accent hover:bg-surface-2 hover:text-fg disabled:pointer-events-none disabled:opacity-35"
                aria-label="Previous suggested imports"
              >
                <ChevronLeftIcon size={18} />
              </button>
              <button
                type="button"
                onClick={() => scrollCarousel(1)}
                disabled={!canScrollRight}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface-1 text-fg-muted transition hover:border-accent hover:bg-surface-2 hover:text-fg disabled:pointer-events-none disabled:opacity-35"
                aria-label="Next suggested imports"
              >
                <ChevronRightIcon size={18} />
              </button>
            </div>
          )}
        </div>
      </div>

      {pool.items.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface-1 px-4 py-6 text-center text-sm text-fg-muted">
          {emptyMessage}
        </div>
      ) : (
        <div
          ref={carouselRef}
          onScroll={updateScrollControls}
          className="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-smooth px-1 pb-2 md:overflow-x-hidden"
        >
          {pool.items.map((item) => {
            const pending = busy.has(item.id);
            return (
              <MobileSwipeTrack
                key={item.id}
                as="article"
                track={item.track}
                className="w-40 shrink-0 snap-start overflow-hidden rounded-xl border border-border bg-surface-1 sm:w-48"
                contentClassName="h-full"
                surfaceClassName="bg-surface-1"
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
                      className="flex h-10 items-center justify-center gap-1 rounded-md bg-accent px-2 text-xs font-semibold text-accent-fg transition hover:bg-accent-hover disabled:opacity-50"
                      aria-label={`Keep ${item.track.title}`}
                    >
                      <CheckIcon className="h-5 w-5 md:h-4 md:w-4" />
                      <span className="hidden md:inline">Keep</span>
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => void mutate(item.id, "reject")}
                      className="flex h-10 items-center justify-center gap-1 rounded-md border border-border px-2 text-xs font-semibold text-fg-muted transition hover:border-red-400/60 hover:text-red-400 disabled:opacity-50"
                      aria-label={`Reject ${item.track.title}`}
                    >
                      <XIcon className="h-5 w-5 md:h-4 md:w-4" />
                      <span className="hidden md:inline">Reject</span>
                    </button>
                  </div>
                </div>
              </MobileSwipeTrack>
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
