import Link from "next/link";
import type { PlaylistDTO } from "@/lib/types";
import { MusicIcon } from "@/components/icons";

export default function PlaylistCard({ playlist }: { playlist: PlaylistDTO }) {
  return (
    <Link
      href={`/playlists/${playlist.id}`}
      className="group rounded-lg border border-neutral-800 bg-neutral-900 p-3 transition hover:border-neutral-700 hover:bg-neutral-800/60"
    >
      {playlist.coverUrl ? (
        // Presigned S3 URL; next/image cannot optimize short-lived URLs.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={playlist.coverUrl}
          alt=""
          className="aspect-square w-full rounded-md object-cover"
        />
      ) : (
        <div className="flex aspect-square w-full items-center justify-center rounded-md bg-neutral-800 text-neutral-600">
          <MusicIcon size={48} />
        </div>
      )}
      <p className="mt-2 truncate font-medium text-neutral-100 group-hover:text-white">
        {playlist.name}
      </p>
      <p className="text-xs text-neutral-500">
        {playlist.trackCount ?? 0} track{(playlist.trackCount ?? 0) === 1 ? "" : "s"}
      </p>
    </Link>
  );
}
