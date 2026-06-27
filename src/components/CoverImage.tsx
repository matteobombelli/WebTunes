"use client";

import { useEffect, useRef, useState } from "react";
import { MusicIcon } from "@/components/icons";

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 400;

/**
 * Cover-art <img> for a short-lived presigned-redirect URL (track art via
 * /api/tracks/:id/art, playlist covers via /api/playlists/:id/cover), resilient
 * to transient load failures. On error it retries a few times with backoff and
 * a cache-busting query (`?r=<n>`) — which forces the route to mint a *fresh*
 * presigned redirect, recovering from an expired cached 302 → 403 that a plain
 * retry of the same URL could not — before falling back to a music-note
 * placeholder. `src={null}` (no art) shows the placeholder immediately.
 *
 * `className` carries the full box classes (size, rounding, bg); it applies to
 * both the image and the placeholder so callers control the shape in one place.
 */
export default function CoverImage({
  src,
  className = "",
  iconSize,
}: {
  src: string | null;
  className?: string;
  iconSize?: number;
}) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [prevSrc, setPrevSrc] = useState(src);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset retry state when the underlying art changes (list rows reuse this
  // component for a different track). Adjusting state during render is React's
  // recommended alternative to a reset effect.
  if (src !== prevSrc) {
    setPrevSrc(src);
    setAttempt(0);
    setFailed(false);
  }

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  if (!src || failed) {
    return (
      <div className={`flex items-center justify-center text-fg-subtle ${className}`}>
        <MusicIcon size={iconSize} />
      </div>
    );
  }

  const url =
    attempt === 0
      ? src
      : `${src}${src.includes("?") ? "&" : "?"}r=${attempt}`;
  const onError = () => {
    if (attempt >= MAX_RETRIES) {
      setFailed(true);
      return;
    }
    timer.current = setTimeout(
      () => setAttempt(attempt + 1),
      BASE_DELAY_MS * 2 ** attempt
    );
  };

  return (
    // Presigned S3 redirect; next/image cannot optimize short-lived URLs.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      loading="lazy"
      onError={onError}
      className={`object-cover ${className}`}
    />
  );
}
