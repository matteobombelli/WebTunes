import { flatExtract, type FlatEntry } from "@/lib/import/ytdlp";
import type { SourceTrack } from "@/lib/import/sources";
import type { ImportVersionPref } from "@/lib/types";

// Resolve a Spotify/Apple track's metadata to the best-matching YouTube video.
// Port of the desktop importer's core/matching.py: below the strictness
// threshold a track is skipped with a reason, never guessed.

export const DEFAULT_STRICTNESS = 0.7; // match-score floor, user-adjustable 0..1
const DURATION_TOLERANCE = 15; // seconds
const SEARCH_RESULTS = 10; // candidates to scan per track when matching
export const MIN_SOURCE_KBPS = 100; // drop sources whose best audio is below this

const BRACKETS = /\(.*?\)|\[.*?\]/g;
const NOISE_WORDS =
  /\b(official|video|audio|lyrics?|music|hd|4k|remaster(ed)?|topic|vevo)\b/g;

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(BRACKETS, " ")
    .replace(NOISE_WORDS, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Matched on the raw title — normalize() strips "(Live)"/"(Remix)" brackets.
const LIVE_PATTERNS = /\b(live|concert|unplugged|tour)\b/;
const JUNK_PATTERNS =
  /\b(remix|sped[\s-]?up|slowed|nightcore|reverb|8d|cover|karaoke|mashup)\b/;

/**
 * True if a candidate title is acceptable for the requested version.
 * studio — reject live takes and weird versions; live — require a live
 * indicator; none — everything allowed. Word-boundary matching can mis-flag
 * legitimate titles ("Live and Let Die"); accepted, since every drop is
 * reported.
 */
export function versionAllowed(title: string, pref: ImportVersionPref): boolean {
  const t = title.toLowerCase();
  if (pref === "studio") return !LIVE_PATTERNS.test(t) && !JUNK_PATTERNS.test(t);
  if (pref === "live") return LIVE_PATTERNS.test(t);
  return true;
}

// Total matching characters per Ratcliff/Obershelp: the longest common
// substring, then recurse on what's left of both sides — the same measure
// difflib.SequenceMatcher's ratio() is built on (titles are far below the
// length where difflib's junk heuristics would diverge).
function matchingChars(a: string, b: string): number {
  if (!a || !b) return 0;
  let bestA = 0;
  let bestB = 0;
  let bestLen = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > bestLen) {
          bestLen = cur[j];
          bestA = i - cur[j];
          bestB = j - cur[j];
        }
      }
    }
    prev = cur;
  }
  if (bestLen === 0) return 0;
  return (
    bestLen +
    matchingChars(a.slice(0, bestA), b.slice(0, bestB)) +
    matchingChars(a.slice(bestA + bestLen), b.slice(bestB + bestLen))
  );
}

/** Order-invariant similarity: compare the sorted word sets so that
 * "artist title" and "title … artist" score the same. */
function ratio(a: string, b: string): number {
  const sa = a.split(" ").filter(Boolean).sort().join(" ");
  const sb = b.split(" ").filter(Boolean).sort().join(" ");
  if (!sa.length && !sb.length) return 1;
  return (2 * matchingChars(sa, sb)) / (sa.length + sb.length);
}

export function matchScore(track: SourceTrack, entry: FlatEntry): number {
  const want = normalize(`${track.artist} ${track.title}`);
  const title = normalize(entry.title);
  // Official "Artist - Topic"/VEVO uploads often carry only the song name in
  // the title and the artist in the channel, so also try title+channel and take
  // the better fit; a junk channel just makes that variant score lower.
  const channel = normalize(entry.uploader);
  let score = Math.max(ratio(want, title), ratio(want, `${title} ${channel}`.trim()));
  if (
    track.duration &&
    entry.duration &&
    Math.abs(entry.duration - track.duration) > DURATION_TOLERANCE
  ) {
    score -= 0.2;
  }
  return score;
}

/**
 * Search YouTube for the track and return the best-scoring candidate — url on
 * a confident match (score ≥ threshold), otherwise a reason explaining the
 * skip.
 */
export async function findMatch(
  track: SourceTrack,
  pref: ImportVersionPref,
  threshold: number,
  signal: AbortSignal
): Promise<{ url: string; score: number } | { url: null; reason: string }> {
  let query = `${track.artist} ${track.title}`;
  if (pref === "live") query += " live";
  const results = await flatExtract(`ytsearch${SEARCH_RESULTS}:${query}`, signal);
  const entries = results.filter((e) => versionAllowed(e.title, pref));
  if (entries.length === 0) {
    return { url: null, reason: `no ${pref} version in top ${SEARCH_RESULTS} results` };
  }
  let best = entries[0];
  let bestScore = -Infinity;
  for (const e of entries) {
    const score = matchScore(track, e);
    if (score > bestScore) {
      best = e;
      bestScore = score;
    }
  }
  if (bestScore >= threshold) return { url: best.url, score: bestScore };
  return {
    url: null,
    reason: `below strictness ${threshold.toFixed(2)}, best ${bestScore.toFixed(2)}`,
  };
}
