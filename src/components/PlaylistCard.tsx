import Link from "next/link";
import type { PlaylistDTO } from "@/lib/types";
import PlaylistCover from "@/components/PlaylistCover";
import { LockIcon, UsersIcon } from "@/components/icons";

export default function PlaylistCard({ playlist }: { playlist: PlaylistDTO }) {
  return (
    <Link
      href={`/playlists/${playlist.id}`}
      className="group relative block transition duration-200 ease-out hover:z-10 hover:scale-105"
    >
      <div className="overflow-hidden rounded-md">
        <PlaylistCover
          playlistId={playlist.id}
          coverS3Key={playlist.coverS3Key}
          artTrackIds={playlist.coverTrackIds}
          iconSize={48}
          className="aspect-square w-full bg-surface-2"
        />
      </div>
      <p className="mt-2 flex items-center gap-1 truncate font-medium text-fg">
        {!playlist.ownerName && playlist.isPrivate && (
          <LockIcon size={13} className="shrink-0 text-fg-subtle" />
        )}
        <span className="truncate">{playlist.name}</span>
      </p>
      <p className="flex items-center gap-1 truncate text-xs text-fg-subtle">
        {playlist.role === "collaborator" && (
          <span
            title="You collaborate on this playlist"
            className="flex shrink-0 items-center gap-0.5 text-accent-bright"
          >
            <UsersIcon size={12} />
          </span>
        )}
        <span className="truncate">
          {playlist.ownerName ? `${playlist.ownerName} · ` : ""}
          {playlist.trackCount ?? 0} track
          {(playlist.trackCount ?? 0) === 1 ? "" : "s"}
        </span>
      </p>
    </Link>
  );
}
