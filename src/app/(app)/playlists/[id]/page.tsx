import { notFound } from "next/navigation";
import { requirePageUser } from "@/lib/auth-helpers";
import { getPlaylistWithTracks, listCollaborators } from "@/lib/playlists";
import { isUuid } from "@/lib/validate";
import PlaylistDetail from "@/components/PlaylistDetail";

export default async function PlaylistPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePageUser();

  const { id } = await params;
  // Collaborators load alongside the access check (discarded on 404); the id
  // guard keeps a malformed id from reaching the uuid column.
  const [data, collaborators] = await Promise.all([
    getPlaylistWithTracks(id, user.id),
    isUuid(id) ? listCollaborators(id) : Promise.resolve([]),
  ]);
  if (!data) notFound();
  const { tracks, ...playlist } = data;

  return (
    <PlaylistDetail
      playlist={playlist}
      tracks={tracks}
      viewerId={user.id}
      isOwner={playlist.ownerId === user.id}
      canEdit={playlist.role !== null}
      collaborators={collaborators}
    />
  );
}
