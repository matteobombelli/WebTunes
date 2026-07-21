// JSON shapes shared between API routes and client components.

export type TrackDTO = {
  id: string;
  ownerId: string;
  title: string;
  artist: string | null;
  album: string | null;
  durationSec: number | null;
  /** Integrated loudness (LUFS) for volume normalization; null if unmeasured. */
  loudnessLufs: number | null;
  /** S3 key of embedded cover art; null when the file had none. */
  artS3Key: string | null;
  mimeType: string | null;
  fileSize: number | null;
  isPrivate: boolean;
  /** Historical non-owner listens (legacy 30-second + current 50% rules). */
  friendPlayCount: number;
  createdAt: string;
  /** Present when the track belongs to someone else (friend views, search). */
  ownerName?: string | null;
  /** Present only for private Suggested Imports preview DTOs. */
  isSuggested?: boolean;
};

/** One keyset-paginated slice of a newest-first track listing. */
export type TrackPageDTO = {
  tracks: TrackDTO[];
  /** Total rows in this scope, independent of this page's cursor and limit. */
  totalCount: number;
  /** Opaque cursor for the next page; null means the listing is exhausted. */
  nextCursor: string | null;
};

export type SuggestedImportDTO = {
  id: string;
  track: TrackDTO;
  reason: string | null;
};

export type SuggestedImportPoolDTO = {
  items: SuggestedImportDTO[];
  target: number;
  processing: number;
  /** Explains why a pool can remain empty even though no job is failing. */
  blockedReason: "no_key" | "no_seeds" | null;
};

export type PlaylistDTO = {
  id: string;
  ownerId: string;
  name: string;
  coverS3Key: string | null;
  isPrivate: boolean;
  trackCount?: number;
  createdAt: string;
  updatedAt: string;
  /** Present when the playlist belongs to a friend (non-own scope views). */
  ownerName?: string | null;
  /** Up to 4 art-bearing track ids, in position order, for the no-cover mosaic. */
  coverTrackIds?: string[];
  /**
   * The viewer's relationship to this playlist: "owner", "collaborator" (a
   * friend the owner granted edit access), or null/absent for a read-only
   * friend view. Editors (owner or collaborator) may add/remove/reorder tracks,
   * rename, and change the cover; only the owner controls privacy/delete and
   * who collaborates.
   */
  role?: "owner" | "collaborator" | null;
};

// `name` is the public username; email is intentionally never exposed to other
// users. Also the shape returned by the username search.
export type FriendDTO = {
  id: string;
  name: string;
  /**
   * Historical non-owner listens across this friend's whole library
   * (sum of tracks.friend_play_count). Only set by `friendsOf`; absent in
   * username search results and friend-request users.
   */
  friendListens?: number;
};

export type FriendRequestDTO = {
  id: string;
  direction: "incoming" | "outgoing";
  user: FriendDTO;
  createdAt: string;
};

/** A "you might know" suggestion: a friend-of-a-friend with mutual count. */
export type FriendSuggestionDTO = {
  id: string;
  name: string;
  mutualCount: number;
};

export type StatsRange = "7d" | "30d" | "90d" | "6m" | "1y";

export type StatsDailyActivityDTO = {
  /** Local calendar date in YYYY-MM-DD form. */
  date: string;
  listens: number;
  listeningSeconds: number;
};

export type StatsHourlyActivityDTO = {
  /** Local hour, from 0 through 23. */
  hour: number;
  listens: number;
  averagePerActiveDay: number;
};

export type StatsRankedTrackDTO = {
  track: TrackDTO;
  listens: number;
  listeningSeconds: number;
};

export type StatsRankedNameDTO = {
  /** Null is displayed as Unknown artist / Unknown album. */
  name: string | null;
  listens: number;
  listeningSeconds: number;
  /** An accessible art-bearing track representing this artist/album. */
  artTrack: TrackDTO | null;
};

export type StatsRankedFriendDTO = {
  id: string;
  name: string;
  listens: number;
};

export type StatsDTO = {
  range: StatsRange;
  timeZone: string;
  period: {
    start: string;
    end: string;
  };
  summary: {
    listens: number;
    listeningSeconds: number;
    activeDays: number;
    uniqueTracks: number;
    newDiscoveries: number;
    longestStreak: number;
    busiestDay: { date: string; listens: number } | null;
    peakHour: { hour: number; listens: number } | null;
  };
  daily: StatsDailyActivityDTO[];
  hourly: StatsHourlyActivityDTO[];
  topTracks: StatsRankedTrackDTO[];
  topArtists: StatsRankedNameDTO[];
  topAlbums: StatsRankedNameDTO[];
  outgoingFriends: StatsRankedFriendDTO[];
  incomingFriends: StatsRankedFriendDTO[];
};

export type InviteDTO = {
  token: string;
  createdAt: string;
  expiresAt: string;
  /** Display name of whoever redeemed this link, or null if still unused. */
  usedByName: string | null;
};

/** A connected WebTunes Importer extension, for the Settings revoke list. */
export type ExtensionTokenDTO = {
  id: string;
  /** Browser label sent at pairing ("Firefox on Linux"), or null. */
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};

// --- Server-side imports (lib/import/) ---------------------------------------
// Types live here (not in lib/import/jobs.ts) so client components can use them
// without pulling the server-only import modules (fs/child_process) into a
// client bundle.

export type ImportQuality = "128" | "192" | "opus" | "m4a";
export type ImportVersionPref = "none" | "studio" | "live";

export type ImportItemStatus =
  | "waiting"
  | "matching"
  | "downloading"
  | "uploading"
  | "done"
  | "duplicate"
  | "missed"
  | "cancelled";

export type ImportJobStatus =
  | "queued"
  | "resolving"
  | "running"
  | "done"
  | "cancelled"
  | "error";

export type ImportItemDTO = {
  label: string;
  status: ImportItemStatus;
  /** 0–100 download percent for the current item. */
  progress: number;
  /** Why it was missed / flagged duplicate. */
  reason: string | null;
};

export type ImportJobDTO = {
  id: string;
  sourceUrl: string;
  kind: "youtube" | "spotify" | "apple";
  status: ImportJobStatus;
  error: string | null;
  items: ImportItemDTO[];
  /** Progress log lines, shown in the Import dialog's Link tab (mirrors the
   * desktop importer's log view). */
  log: string[];
  createdAt: string;
  finishedAt: string | null;
};

/** One row of the Import dialog's YouTube search tab. */
export type ImportSearchResultDTO = {
  id: string;
  url: string;
  title: string;
  uploader: string;
  duration: number | null;
  thumbnail: string | null;
};
