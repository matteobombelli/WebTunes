"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { TrackDTO } from "@/lib/types";

function rgbToHsl(
  r: number,
  g: number,
  b: number
): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}

/**
 * Pick the cover's most prominent colour: quantize pixels into coarse RGB
 * buckets, ignore near-black/white and washed-out greys, and take the most
 * populous vivid bucket (weighted by saturation). Falls back to the overall
 * average when nothing vivid stands out; null only if there are no pixels.
 */
function dominantColor(
  data: Uint8ClampedArray
): [number, number, number] | null {
  const buckets = new Map<
    number,
    { n: number; r: number; g: number; b: number }
  >();
  let totalN = 0;
  let tr = 0;
  let tg = 0;
  let tb = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (data[i + 3] < 125) continue; // skip near-transparent
    totalN++;
    tr += r;
    tg += g;
    tb += b;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { n: 0, r: 0, g: 0, b: 0 };
      buckets.set(key, bucket);
    }
    bucket.n++;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
  }
  if (totalN === 0) return null;

  let best: { score: number; r: number; g: number; b: number } | null = null;
  for (const bk of buckets.values()) {
    const r = bk.r / bk.n;
    const g = bk.g / bk.n;
    const b = bk.b / bk.n;
    const [, s, l] = rgbToHsl(r, g, b);
    if (l < 0.12 || l > 0.9 || s < 0.22) continue; // not a "prominent" colour
    const score = bk.n * (0.4 + s); // frequency weighted by vividness
    if (!best || score > best.score) best = { score, r, g, b };
  }

  if (best) return [best.r, best.g, best.b];
  return [tr / totalN, tg / totalN, tb / totalN];
}

function buildGradient([r, g, b]: [number, number, number]): string {
  const [h, s] = rgbToHsl(r, g, b);
  const hue = Math.round(h);
  // Shift: boost saturation, push lightness down so white text stays legible.
  const sat = Math.round(Math.min(0.85, Math.max(0.5, s)) * 100);
  return `linear-gradient(180deg, hsl(${hue} ${sat}% 30%), hsl(${hue} ${sat}% 7%))`;
}

/**
 * A ready-to-use CSS `background` gradient derived from a track's cover art's
 * most prominent colour (shifted darker/saturated), or null while loading or on
 * any failure (no art, fetch error, CORS-tainted canvas) — callers fall back to
 * a plain background. Reads the CORS-readable presigned URL from `/art-url`
 * (the SW-intercepted `/art` redirect isn't safe to read pixels from).
 */
export function useArtGradient(track: TrackDTO | null): string | null {
  const trackId = track?.id ?? null;
  const hasArt = !!track?.artS3Key;

  const [gradient, setGradient] = useState<string | null>(null);
  const [prevKey, setPrevKey] = useState(trackId);
  if (trackId !== prevKey) {
    // Reset during render (not in an effect) when the track changes.
    setPrevKey(trackId);
    setGradient(null);
  }

  useEffect(() => {
    if (!trackId || !hasArt) return;
    let cancelled = false;

    api<{ url: string }>(`/tracks/${trackId}/art-url`)
      .then(({ url }) => {
        if (cancelled) return;
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          if (cancelled) return;
          try {
            const N = 32;
            const canvas = document.createElement("canvas");
            canvas.width = N;
            canvas.height = N;
            const ctx = canvas.getContext("2d");
            if (!ctx) return;
            ctx.drawImage(img, 0, 0, N, N);
            const color = dominantColor(ctx.getImageData(0, 0, N, N).data);
            if (color && !cancelled) setGradient(buildGradient(color));
          } catch {
            // Tainted canvas / read failure → leave null, caller falls back.
          }
        };
        img.src = url;
      })
      .catch(() => {
        // art-url fetch failed → leave null.
      });

    return () => {
      cancelled = true;
    };
  }, [trackId, hasArt]);

  return gradient;
}
