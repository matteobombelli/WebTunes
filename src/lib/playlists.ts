import { eq } from "drizzle-orm";
import { db } from "@/db";
import { playlists, type Playlist } from "@/db/schema";
import { getPresignedGetUrl } from "@/lib/s3";
import type { PlaylistDTO } from "@/lib/types";

export async function toPlaylistDTO(
  playlist: Playlist,
  trackCount?: number
): Promise<PlaylistDTO> {
  let coverUrl: string | null = null;
  if (playlist.coverS3Key) {
    coverUrl = (await getPresignedGetUrl(playlist.coverS3Key)).url;
  }
  return {
    id: playlist.id,
    ownerId: playlist.ownerId,
    name: playlist.name,
    coverS3Key: playlist.coverS3Key,
    coverUrl,
    trackCount,
    createdAt: playlist.createdAt.toISOString(),
    updatedAt: playlist.updatedAt.toISOString(),
  };
}

/** Loads a playlist only if it belongs to the given user. */
export async function getOwnPlaylist(playlistId: string, userId: string) {
  const [playlist] = await db
    .select()
    .from(playlists)
    .where(eq(playlists.id, playlistId));
  if (!playlist || playlist.ownerId !== userId) return null;
  return playlist;
}
