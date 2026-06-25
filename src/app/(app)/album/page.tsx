import Link from "next/link";
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

  const artists = [...new Set(tracks.map((t) => t.artist).filter(Boolean))];
  const albumArtist =
    artists.length === 1 ? artists[0] : artists.length > 1 ? "Various Artists" : null;

  return (
    <div className="mx-auto max-w-5xl">
      <p className="text-sm text-fg-muted">Album</p>
      <h1 className={`font-display text-2xl font-bold tracking-tight ${albumArtist ? "" : "mb-6"}`}>{name}</h1>
      {albumArtist && (
        <p className="mb-6 text-sm text-fg-muted">
          {albumArtist === "Various Artists" ? (
            albumArtist
          ) : (
            <Link
              href={`/artist?name=${encodeURIComponent(albumArtist)}`}
              className="hover:text-accent-bright hover:underline"
            >
              {albumArtist}
            </Link>
          )}
        </p>
      )}
      <TrackList tracks={tracks} showOwner canDelete selectable />
    </div>
  );
}
