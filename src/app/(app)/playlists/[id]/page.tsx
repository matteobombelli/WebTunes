import { asc, eq } from "drizzle-orm";
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

  const rows = await db
    .select({ track: tracks, ownerName: users.name })
    .from(playlistTracks)
    .innerJoin(tracks, eq(playlistTracks.trackId, tracks.id))
    .innerJoin(users, eq(tracks.ownerId, users.id))
    .where(eq(playlistTracks.playlistId, id))
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
