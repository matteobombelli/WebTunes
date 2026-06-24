import Link from "next/link";
import type { PlaylistDTO } from "@/lib/types";
import { LockIcon, MusicIcon } from "@/components/icons";
import { cardClass } from "@/components/ui/Card";

export default function PlaylistCard({ playlist }: { playlist: PlaylistDTO }) {
  return (
    <Link
      href={`/playlists/${playlist.id}`}
      className={`group block p-3 ${cardClass}`}
    >
      {playlist.coverUrl ? (
        // Presigned S3 URL; next/image cannot optimize short-lived URLs.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={playlist.coverUrl}
          alt=""
          loading="lazy"
          className="aspect-square w-full rounded-md object-cover"
        />
      ) : (
        <div className="flex aspect-square w-full items-center justify-center rounded-md bg-surface-2 text-fg-subtle">
          <MusicIcon size={48} />
        </div>
      )}
      <p className="mt-2 flex items-center gap-1 truncate font-medium text-fg group-hover:text-white">
        {!playlist.ownerName && playlist.isPrivate && (
          <LockIcon size={13} className="shrink-0 text-fg-subtle" />
        )}
        <span className="truncate">{playlist.name}</span>
      </p>
      <p className="truncate text-xs text-fg-subtle">
        {playlist.ownerName ? `${playlist.ownerName} · ` : ""}
        {playlist.trackCount ?? 0} track{(playlist.trackCount ?? 0) === 1 ? "" : "s"}
      </p>
    </Link>
  );
}
