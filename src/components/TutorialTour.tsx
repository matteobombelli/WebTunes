"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { usePlayerStore } from "@/stores/player";
import { Button } from "@/components/ui/Button";

type TourStep = {
  title: string;
  body: string;
  /** data-tour attribute of the element to spotlight. Omitted, or present but
   *  not found/visible (e.g. the player bar before anything has played, or a
   *  desktop-only control on mobile), falls back to a centered card. */
  anchor?: string;
  /** Page that hosts the anchor; navigated to before searching for it. */
  route?: string;
};

const STEPS: TourStep[] = [
  {
    title: "Welcome to WebTunes",
    body: "Your personal music library: upload your collection, stream it anywhere, and share it with friends. This short tour points out the essentials. You can replay it any time from Settings.",
  },
  {
    title: "Add your music",
    body: "Upload audio files straight from your device, or press Import and paste a YouTube, Spotify, or Apple Music link to have the tracks fetched for you.",
    anchor: "add-music",
    route: "/library",
  },
  {
    title: "Play similar",
    body: "Play any track, then use the radio button in the player to start a station of songs that sound alike. Settings lets you tune how closely it sticks to the seed and whether it drifts as it plays.",
    anchor: "play-similar",
  },
  {
    title: "Friends and sharing",
    body: "Discover is where you add friends, invite new people, and see what everyone is playing. Friends' tracks appear alongside your own (the switcher in Library picks whose you browse), and any track can be shared with a public link.",
    anchor: "nav-discover",
  },
  {
    title: "Take it offline",
    body: "Download tracks and playlists to keep listening without a connection. On your phone, add WebTunes to the home screen to use it like a native app.",
    anchor: "nav-downloads",
  },
  {
    title: "That's the tour",
    body: "Enjoy the music. If you ever want a refresher, the tour lives in Settings.",
  },
];

/** How long to keep polling for a step's anchor before falling back to a
 *  centered card (covers the route push on the add-music step). */
const FIND_TRIES = 40;
const FIND_INTERVAL_MS = 50;
const SPOTLIGHT_PAD = 6;
const CARD_MARGIN = 16;
/** Rough card height used only to decide above vs below placement. */
const CARD_EST_H = 230;

/** First visible element carrying the anchor (Sidebar and MobileNav both tag
 *  their nav links; only one is rendered at a given breakpoint). */
function findAnchor(name: string): HTMLElement | null {
  const els = document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`);
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

/**
 * First-open tutorial: a spotlight overlay that steps through the main
 * features, highlighting the real UI element for each. Rendered once in the
 * app layout; auto-starts when the account hasn't seen it (users.tutorial_seen)
 * and is replayable via the settings modal (player store's `tutorialOpen`).
 * Completing or skipping marks it seen through the settings PATCH.
 */
export default function TutorialTour({ initialSeen }: { initialSeen: boolean }) {
  const open = usePlayerStore((s) => s.tutorialOpen);
  const router = useRouter();
  const pathname = usePathname();
  const [step, setStep] = useState(0);
  // Step-keyed so a lingering measurement from the previous step never
  // spotlights the wrong element; the derived `rect` below ignores it.
  const [spot, setSpot] = useState<{ step: number; rect: DOMRect } | null>(
    null
  );
  const targetRef = useRef<HTMLElement | null>(null);
  const rect = spot && spot.step === step ? spot.rect : null;

  // Auto-start once for accounts that haven't seen the tour. The short delay
  // lets the first page paint so the overlay doesn't pop mid-hydration.
  useEffect(() => {
    if (initialSeen) return;
    const t = setTimeout(
      () => usePlayerStore.getState().setTutorialOpen(true),
      600
    );
    return () => clearTimeout(t);
  }, [initialSeen]);

  // Locate the current step's anchor, navigating to its page first when the
  // step declares one. Polls briefly so a just-pushed route can render.
  useEffect(() => {
    if (!open) return;
    const spec = STEPS[step];
    targetRef.current = null;
    if (!spec.anchor) return;
    if (spec.route && pathname !== spec.route) {
      router.push(spec.route);
    }
    let cancelled = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const find = () => {
      if (cancelled) return;
      const el = findAnchor(spec.anchor!);
      if (el) {
        el.scrollIntoView({ block: "nearest" });
        targetRef.current = el;
        setSpot({ step, rect: el.getBoundingClientRect() });
      } else if (++tries < FIND_TRIES) {
        timer = setTimeout(find, FIND_INTERVAL_MS);
      }
      // Never found: `spot` stays stale for this step and the card centers.
    };
    timer = setTimeout(find, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, step, pathname, router]);

  // Keep the spotlight glued to its element across resizes and scrolls (the
  // main content pane scrolls, hence the capture-phase listener).
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const el = targetRef.current;
      if (el && el.isConnected)
        setSpot({ step, rect: el.getBoundingClientRect() });
    };
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, step]);

  // Closing by any path (Done, Skip, Escape) counts as having seen the tour.
  // The step reset here is what makes a later replay start from the top.
  const dismiss = useCallback(() => {
    usePlayerStore.getState().setTutorialOpen(false);
    setStep(0);
    api("/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tutorialSeen: true }),
    }).catch(() => {
      // Best-effort: worst case the tour shows again next visit.
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, dismiss]);

  if (!open) return null;

  const current = STEPS[step];
  const last = step === STEPS.length - 1;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cardWidth = Math.min(320, vw - CARD_MARGIN * 2);

  // Anchored: below the spotlight when there's room, otherwise above it,
  // clamped to the viewport horizontally. Unanchored: centered.
  let cardStyle: React.CSSProperties | undefined;
  if (rect) {
    const left = Math.min(
      Math.max(rect.left, CARD_MARGIN),
      vw - cardWidth - CARD_MARGIN
    );
    cardStyle =
      rect.bottom + SPOTLIGHT_PAD + CARD_MARGIN + CARD_EST_H <= vh
        ? { top: rect.bottom + SPOTLIGHT_PAD + 12, left, width: cardWidth }
        : {
            top: Math.max(rect.top - SPOTLIGHT_PAD - 12, CARD_MARGIN),
            left,
            width: cardWidth,
            transform: "translateY(-100%)",
          };
  }

  const card = (
    <div
      className="animate-pop-in pointer-events-auto rounded-xl border border-border bg-surface-1 p-4 shadow-2xl"
      style={{ width: cardWidth }}
    >
      <p className="text-xs text-fg-subtle">
        {step + 1} of {STEPS.length}
      </p>
      <h2 className="mt-1 font-display text-lg font-bold text-fg">
        {current.title}
      </h2>
      <p className="mt-1.5 text-sm text-fg-muted">{current.body}</p>
      <div className="mt-4 flex items-center">
        {!last && (
          <Button variant="ghost" size="sm" onClick={dismiss}>
            Skip
          </Button>
        )}
        <div className="ml-auto flex gap-2">
          {step > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setStep(step - 1)}
            >
              Back
            </Button>
          )}
          <Button
            size="sm"
            onClick={last ? dismiss : () => setStep(step + 1)}
          >
            {last ? "Done" : "Next"}
          </Button>
        </div>
      </div>
    </div>
  );

  // z-[85]: above the dialogs (z-[75]) and Toast (z-[80]) so nothing sits on
  // top of the spotlight while the tour runs.
  return (
    <div
      className="animate-fade-in fixed inset-0 z-[85]"
      role="dialog"
      aria-modal="true"
      aria-label="WebTunes tutorial"
    >
      {rect ? (
        // The giant box-shadow dims everything except the spotlit element.
        <div
          className="absolute rounded-xl ring-2 ring-accent-bright"
          style={{
            top: rect.top - SPOTLIGHT_PAD,
            left: rect.left - SPOTLIGHT_PAD,
            width: rect.width + SPOTLIGHT_PAD * 2,
            height: rect.height + SPOTLIGHT_PAD * 2,
            boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.65)",
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-black/65" />
      )}
      {rect ? (
        <div className="absolute" style={cardStyle}>
          {card}
        </div>
      ) : (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
          {card}
        </div>
      )}
    </div>
  );
}
