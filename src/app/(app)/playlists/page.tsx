import { requirePageUser } from "@/lib/auth-helpers";
import { listPlaylistsWithCount } from "@/lib/playlists";
import CreatePlaylistButton from "@/components/CreatePlaylistButton";
import PlaylistBrowser from "@/components/PlaylistBrowser";

export default async function PlaylistsPage() {
  const user = await requirePageUser();
  const dtos = await listPlaylistsWithCount(user.id);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-display text-4xl font-bold tracking-tight">Playlists</h1>
        <CreatePlaylistButton />
      </div>
      <PlaylistBrowser initialPlaylists={dtos} />
    </div>
  );
}
