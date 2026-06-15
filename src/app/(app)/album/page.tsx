import { notFound } from "next/navigation";
import { requirePageUser } from "@/lib/auth-helpers";
import { listTracksByAlbum } from "@/lib/tracks";
import { getUserSettings } from "@/lib/users";
import TrackList from "@/components/TrackList";

export default async function AlbumPage({
  searchParams,
}: {
  searchParams: Promise<{ name?: string }>;
}) {
  const user = await requirePageUser();
  const { name } = await searchParams;
  if (!name) notFound();

  const settings = await getUserSettings(user.id);
  const tracks = await listTracksByAlbum(
    user.id,
    name,
    settings.hideFriendDuplicates
  );

  return (
    <div className="mx-auto max-w-5xl">
      <p className="text-sm text-neutral-400">Album</p>
      <h1 className="mb-6 text-2xl font-bold">{name}</h1>
      <TrackList tracks={tracks} showOwner />
    </div>
  );
}
