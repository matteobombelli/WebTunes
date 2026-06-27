import Link from "next/link";
import { playlistCoverSrc } from "@/lib/api";
import type { PlaylistDTO } from "@/lib/types";
import CoverImage from "@/components/CoverImage";
import { LockIcon } from "@/components/icons";

export default function PlaylistCard({ playlist }: { playlist: PlaylistDTO }) {
  return (
    <Link
      href={`/playlists/${playlist.id}`}
      className="group relative block transition duration-200 ease-out hover:z-10 hover:scale-105"
    >
      <div className="overflow-hidden rounded-md">
        <CoverImage
          src={playlist.coverS3Key ? playlistCoverSrc(playlist.id) : null}
          iconSize={48}
          className="aspect-square w-full bg-surface-2"
        />
      </div>
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
