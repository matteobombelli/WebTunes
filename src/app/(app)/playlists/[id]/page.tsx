import { notFound } from "next/navigation";
import { requirePageUser } from "@/lib/auth-helpers";
import {
  getAccessiblePlaylist,
  getPlaylistTracks,
  toPlaylistDTO,
} from "@/lib/playlists";
import { getDisplayName } from "@/lib/users";
import PlaylistDetail from "@/components/PlaylistDetail";

export default async function PlaylistPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePageUser();

  const { id } = await params;
  const playlist = await getAccessiblePlaylist(id, user.id);
  if (!playlist) notFound();

  const isOwner = playlist.ownerId === user.id;
  const [trackDTOs, ownerName] = await Promise.all([
    getPlaylistTracks(id, user.id),
    isOwner ? Promise.resolve(null) : getDisplayName(playlist.ownerId),
  ]);

  return (
    <PlaylistDetail
      playlist={await toPlaylistDTO(playlist, trackDTOs.length, ownerName)}
      tracks={trackDTOs}
      isOwner={isOwner}
    />
  );
}
