// JSON shapes shared between API routes and client components.

export type TrackDTO = {
  id: string;
  ownerId: string;
  title: string;
  artist: string | null;
  album: string | null;
  durationSec: number | null;
  s3Key: string;
  /** S3 key of embedded cover art; null when the file had none. */
  artS3Key: string | null;
  mimeType: string | null;
  fileSize: number | null;
  lyrics: string | null;
  lyricsSource: "embedded" | "lrclib" | "none";
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
  coverUrl: string | null;
  isPrivate: boolean;
  trackCount?: number;
  createdAt: string;
  updatedAt: string;
  /** Present when the playlist belongs to a friend (non-own scope views). */
  ownerName?: string | null;
};

export type FriendDTO = {
  id: string;
  name: string | null;
  email: string;
};

export type FriendRequestDTO = {
  id: string;
  direction: "incoming" | "outgoing";
  user: FriendDTO;
  createdAt: string;
};
