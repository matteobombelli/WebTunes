import { notFound } from "next/navigation";
import { requirePageUser } from "@/lib/auth-helpers";
import {
  getOwnPlaylist,
  getPlaylistTracks,
  toPlaylistDTO,
} from "@/lib/playlists";
import PlaylistDetail from "@/components/PlaylistDetail";

export default async function PlaylistPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePageUser();

  const { id } = await params;
  const playlist = await getOwnPlaylist(id, user.id);
  if (!playlist) notFound();

  const trackDTOs = await getPlaylistTracks(id, user.id);

  return (
    <PlaylistDetail
      playlist={await toPlaylistDTO(playlist, trackDTOs.length)}
      tracks={trackDTOs}
    />
  );
}
