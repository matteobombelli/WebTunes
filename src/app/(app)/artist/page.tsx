import { notFound } from "next/navigation";
import { requirePageUser } from "@/lib/auth-helpers";
import { listTracksByArtist } from "@/lib/tracks";
import { getUserSettings } from "@/lib/users";
import TrackList from "@/components/TrackList";

export default async function ArtistPage({
  searchParams,
}: {
  searchParams: Promise<{ name?: string }>;
}) {
  const user = await requirePageUser();
  const { name } = await searchParams;
  if (!name) notFound();

  const settings = await getUserSettings(user.id);
  const tracks = await listTracksByArtist(
    user.id,
    name,
    settings.hideFriendDuplicates
  );
  // Artists only exist through their tracks - an unknown/typo'd name is a 404,
  // not a real-looking empty artist.
  if (tracks.length === 0) notFound();

  return (
    <div className="mx-auto max-w-5xl">
      <p className="text-xs uppercase text-fg-subtle">Artist</p>
      <h1 className="mb-6 font-display text-4xl font-bold tracking-tight">{name}</h1>
      <TrackList tracks={tracks} showOwner sortable />
    </div>
  );
}
