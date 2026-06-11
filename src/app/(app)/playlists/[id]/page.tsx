import { and, asc, eq, or } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { db } from "@/db";
import { playlistTracks, tracks, users } from "@/db/schema";
import { auth } from "@/lib/auth";
import { getOwnPlaylist, toPlaylistDTO } from "@/lib/playlists";
import type { TrackDTO } from "@/lib/types";
import PlaylistDetail from "@/components/PlaylistDetail";

export default async function PlaylistPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { id } = await params;
  const playlist = await getOwnPlaylist(id, session.user.id);
  if (!playlist) notFound();

  // A friend's track that has since been made private is hidden entirely.
  const rows = await db
    .select({ track: tracks, ownerName: users.name })
    .from(playlistTracks)
    .innerJoin(tracks, eq(playlistTracks.trackId, tracks.id))
    .innerJoin(users, eq(tracks.ownerId, users.id))
    .where(
      and(
        eq(playlistTracks.playlistId, id),
        or(eq(tracks.ownerId, session.user.id), eq(tracks.isPrivate, false))
      )
    )
    .orderBy(asc(playlistTracks.position));

  const trackDTOs: TrackDTO[] = rows.map((r) => ({
    ...r.track,
    createdAt: r.track.createdAt.toISOString(),
    ownerName: r.track.ownerId === session.user.id ? null : r.ownerName,
  }));

  return (
    <PlaylistDetail
      playlist={await toPlaylistDTO(playlist, trackDTOs.length)}
      tracks={trackDTOs}
    />
  );
}
