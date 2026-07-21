/** A playback becomes a listen after at least half of the track has played. */
export function listenQualificationSeconds(
  durationSeconds: number | null | undefined
): number | null {
  if (
    durationSeconds == null ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    return null;
  }
  return Math.max(1, Math.ceil(durationSeconds * 0.5));
}
