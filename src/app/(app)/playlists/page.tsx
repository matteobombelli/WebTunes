import { requirePageUser } from "@/lib/auth-helpers";
import { listPlaylistsWithCount } from "@/lib/playlists";
import CreatePlaylistButton from "@/components/CreatePlaylistButton";
import PlaylistCard from "@/components/PlaylistCard";

export default async function PlaylistsPage() {
  const user = await requirePageUser();
  const dtos = await listPlaylistsWithCount(user.id);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Playlists</h1>
        <CreatePlaylistButton />
      </div>
      {dtos.length === 0 ? (
        <p className="py-8 text-center text-sm text-neutral-500">
          No playlists yet. Create one to organize your music.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {dtos.map((p) => (
            <PlaylistCard key={p.id} playlist={p} />
          ))}
        </div>
      )}
    </div>
  );
}
