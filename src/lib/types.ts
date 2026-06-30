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
  s3Key: string;
  /** S3 key of embedded cover art; null when the file had none. */
  artS3Key: string | null;
  mimeType: string | null;
  fileSize: number | null;
  isPrivate: boolean;
  /** Times a non-owner has played this track to ≥30s. */
  friendPlayCount: number;
  createdAt: string;
  /** Present when the track belongs to someone else (friend views, search). */
  ownerName?: string | null;
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
};

// `name` is the public username; email is intentionally never exposed to other
// users. Also the shape returned by the username search.
export type FriendDTO = {
  id: string;
  name: string;
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

export type InviteDTO = {
  token: string;
  createdAt: string;
  expiresAt: string;
  /** Display name of whoever redeemed this link, or null if still unused. */
  usedByName: string | null;
};
