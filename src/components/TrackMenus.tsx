"use client";

// The per-track action menus (add-to-playlist, the three-dot kebab, and the
// current-track kebab), split out of TrackList so surfaces that only need a
// menu - PlayerBar on every authenticated page, the queue/now-playing sheets -
// don't pull the whole table plus @dnd-kit into their JS graph.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createPortal } from "react-dom";
import { api, playlistCoverSrc } from "@/lib/api";
import type { PlaylistDTO, TrackDTO } from "@/lib/types";
import { usePlayerStore } from "@/stores/player";
import {
  EllipsisIcon,
  PencilIcon,
  PlayNextIcon,
  PlusIcon,
  QueueIcon,
  ShareIcon,
  SimilarIcon,
  TrashIcon,
} from "@/components/icons";
import CoverImage from "@/components/CoverImage";
import DownloadButton from "@/components/DownloadButton";
import EditTrackDialog from "@/components/EditTrackDialog";
import {
  AnchoredMenu,
  useAnchoredMenu,
} from "@/components/ui/AnchoredMenu";
import { MENU_CHROME, MENU_ROW } from "@/components/ui/menu";
import { useConfirmStore } from "@/stores/confirm";
import { useExclusionsStore, useIsExcluded } from "@/stores/exclusions";
import { useToastStore } from "@/stores/toast";

// Create-or-fetch the track's public share link, copy it to the clipboard, then
// flash a toast. Must be CALLED synchronously from the click gesture: Safari/iOS
// only allow a clipboard write tied to a user gesture, so when ClipboardItem is
// available we hand it a *promise* of the link - the async POST resolves without
// losing the gesture's permission - and only fall back to writeText otherwise.
function copyShareLink(trackId: string) {
  const { show } = useToastStore.getState();
  const fetchUrl = () =>
    api<{ url: string }>(`/tracks/${trackId}/shares`, { method: "POST" }).then(
      (r) => r.url
    );
  const copied =
    typeof ClipboardItem !== "undefined" && navigator.clipboard?.write
      ? navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": fetchUrl().then(
              (url) => new Blob([url], { type: "text/plain" })
            ),
          }),
        ])
      : fetchUrl().then((url) => navigator.clipboard.writeText(url));
  copied.then(
    () => show("Copied link to clipboard!"),
    () => show("Couldn’t copy link")
  );
}

export function AddToPlaylistMenu({
  trackIds,
  align = "right",
  bulk = false,
  label,
  onAdded,
  floating = false,
  triggerClassName,
  iconSize = 16,
}: {
  trackIds: string[];
  align?: "left" | "right";
  /** Bulk style: labeled button and per-count feedback. */
  bulk?: boolean;
  /** Non-bulk: when set, the trigger is a full-width labelled menu row. */
  label?: string;
  onAdded?: () => void;
  /** Anchor the dropdown to <body> with outside-click dismissal (like bulk),
   *  but keep the plain "+" icon trigger - for use outside the track table. */
  floating?: boolean;
  /** Overrides the default icon-trigger classes (no label, non-bulk). */
  triggerClassName?: string;
  /** Size of the "+" trigger icon (non-bulk, no label). Default 16. */
  iconSize?: number;
}) {
  // Labelled pickers live inside the already-portalled track kebab. Portal them
  // too so the parent menu's overflow scrolling cannot clip the playlist list.
  const portalled = bulk || floating || label !== undefined;
  const [playlists, setPlaylists] = useState<PlaylistDTO[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const {
    open,
    mounted,
    position,
    triggerRef,
    menuRef,
    close,
    show,
  } = useAnchoredMenu({
    align,
    anchored: portalled,
    estimatedWidth: 224,
    measureKey: playlists,
  });

  const load = async () => {
    if (open) {
      close();
      return;
    }
    show();
    setMessage(null);
    if (!playlists) {
      try {
        setPlaylists(await api<PlaylistDTO[]>("/playlists"));
        setLoadFailed(false);
      } catch {
        // Distinguish "couldn't load" from "no playlists" so a network failure
        // doesn't masquerade as an empty library.
        setPlaylists([]);
        setLoadFailed(true);
      }
    }
  };

  const add = async (playlistId: string) => {
    try {
      const res = await api<{ added: number }>(`/playlists/${playlistId}/tracks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackIds }),
      });
      setMessage(bulk ? `Added ${res.added}` : "Added");
      if (onAdded) setTimeout(onAdded, 600);
      // Portalled menus dismiss once the feedback has shown.
      if (portalled) setTimeout(close, 600);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed");
    }
  };

  const items = (
    <>
      {message && <p className="px-3 py-1 text-accent-bright">{message}</p>}
      {playlists === null && (
        <p className="px-3 py-1 text-fg-muted">Loading…</p>
      )}
      {playlists?.length === 0 && (
        <p className="px-3 py-1 text-fg-muted">
          {loadFailed ? "Couldn’t load playlists" : "No playlists yet"}
        </p>
      )}
      {playlists?.map((p) => (
        <button
          key={p.id}
          onClick={() => add(p.id)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg hover:bg-surface-3"
        >
          <CoverImage
            src={p.coverS3Key ? playlistCoverSrc(p.id) : null}
            iconSize={16}
            className="h-8 w-8 shrink-0 rounded bg-surface-3"
          />
          <span className="truncate">{p.name}</span>
        </button>
      ))}
    </>
  );

  return (
    <div className="relative">
      {bulk ? (
        <button
          ref={triggerRef}
          onClick={load}
          disabled={trackIds.length === 0}
          aria-label="Add to playlist"
          aria-expanded={open}
          title="Add to playlist"
          className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-40"
        >
          <span
            className={`inline-flex transition-transform duration-100 ease-out ${
              open ? "rotate-45" : ""
            }`}
          >
            <PlusIcon size={18} />
          </span>
          <span className="hidden md:inline">Add to playlist</span>
        </button>
      ) : (
        <button
          ref={triggerRef}
          onClick={load}
          aria-label="Add to playlist"
          aria-expanded={open}
          className={
            label
              ? MENU_ROW
              : triggerClassName ??
                "rounded p-1 text-fg-muted hover:bg-surface-3 hover:text-fg"
          }
          title="Add to playlist"
        >
          {label && <span>{label}</span>}
          <span
            className={`inline-flex shrink-0 transition-transform duration-100 ease-out ${
              open ? "rotate-45 text-fg" : ""
            }`}
          >
            <PlusIcon
              size={iconSize}
              className={label ? "text-fg-muted" : undefined}
            />
          </span>
        </button>
      )}
      {portalled ? (
        <AnchoredMenu
          align={align}
          open={open}
          mounted={mounted}
          position={position}
          menuRef={menuRef}
          submenu
          className={`${MENU_CHROME} z-[72] max-h-[80vh] w-56 max-w-[calc(100vw-1rem)] overflow-y-auto py-1`}
        >
          {items}
        </AnchoredMenu>
      ) : (
        mounted && (
          <div
            style={{ transformOrigin: `${align} top` }}
            className={`${open ? "animate-pop-in" : "animate-pop-out"} ${MENU_CHROME} absolute ${align === "left" ? "left-0" : "right-0"} z-10 mt-1 w-56 py-1`}
          >
            {items}
          </div>
        )
      )}
    </div>
  );
}

type TrackActionsProps = {
  track: TrackDTO;
  canEdit: boolean;
  canDelete: boolean;
  onRemove?: (track: TrackDTO) => Promise<void>;
  removeLabel?: string;
  onEdit: (track: TrackDTO) => void;
  onDelete: (track: TrackDTO) => void;
  /** Fires alongside onClose when an artist/album link is tapped, so a
   *  containing overlay (now-playing sheet, queue panel) can dismiss first. */
  onNavigate?: () => void;
  /** Current-track surfaces (queue header, now-playing sheet): drop the
   *  mobile-only Play next / Add to queue rows (the player already does that). */
  playerContext?: boolean;
  onClose: () => void;
};

// The consolidated set of per-track actions, shared by the mobile kebab dialog
// and the desktop three-dot dropdown.
function TrackActions({
  track,
  canEdit,
  canDelete,
  onRemove,
  removeLabel,
  onEdit,
  onDelete,
  onNavigate,
  playerContext = false,
  onClose,
}: TrackActionsProps) {
  const excluded = useIsExcluded(track.id);
  return (
    <div className="flex flex-col gap-2 text-sm">
      {track.artist && !track.isSuggested && (
        <Link
          href={`/artist?name=${encodeURIComponent(track.artist)}`}
          onClick={() => {
            onNavigate?.();
            onClose();
          }}
          className={MENU_ROW}
        >
          <span className="shrink-0">Go to artist</span>
          <span className="truncate text-fg-muted">{track.artist}</span>
        </Link>
      )}
      {track.album && !track.isSuggested && (
        <Link
          href={`/album?name=${encodeURIComponent(track.album)}`}
          onClick={() => {
            onNavigate?.();
            onClose();
          }}
          className={MENU_ROW}
        >
          <span className="shrink-0">Go to album</span>
          <span className="truncate text-fg-muted">{track.album}</span>
        </Link>
      )}
      {/* Desktop hosts Play next / Add to queue as single-click icons on the
          row itself; the menu only needs them on mobile (no hover row). The
          player surfaces (queue/now-playing) drop them entirely. */}
      <div className={`flex-col gap-2 md:hidden ${playerContext ? "hidden" : "flex"}`}>
        <button
          onClick={() => {
            usePlayerStore.getState().playNext([track]);
            onClose();
          }}
          className={MENU_ROW}
        >
          <span>Play next</span>
          <PlayNextIcon size={16} className="shrink-0 text-fg-muted" />
        </button>
        <button
          onClick={() => {
            usePlayerStore.getState().addToQueue([track]);
            onClose();
          }}
          className={MENU_ROW}
        >
          <span>Add to queue</span>
          <QueueIcon size={16} className="shrink-0 text-fg-muted" />
        </button>
      </div>
      {!track.isSuggested && (
        <>
          <AddToPlaylistMenu trackIds={[track.id]} label="Add to playlist" />
          <DownloadButton track={track} label="Download" />
          <button
            onClick={() => {
              const s = useExclusionsStore.getState();
              if (excluded) s.include(track.id);
              else s.exclude(track);
              onClose();
            }}
            className={MENU_ROW}
          >
            <span>
              {excluded ? "Include in Play Similar" : "Exclude from Play Similar"}
            </span>
            <SimilarIcon size={16} className="shrink-0 text-fg-muted" />
          </button>
          {/* Share any accessible track - your own OR a friend's (the server checks
              canAccessTrack). Click copies the public link straight to the
              clipboard (no dialog). */}
          <button
            onClick={() => {
              copyShareLink(track.id);
              onClose();
            }}
            className={MENU_ROW}
          >
            <span>Share</span>
            <ShareIcon size={16} className="shrink-0 text-fg-muted" />
          </button>
          {canEdit && !track.ownerName && (
            <button
              onClick={() => {
                onEdit(track);
                onClose();
              }}
              aria-label="Edit track"
              className={MENU_ROW}
            >
              <span>Edit details</span>
              <PencilIcon size={16} className="shrink-0 text-fg-muted" />
            </button>
          )}
          {(onRemove || (canDelete && !track.ownerName)) && (
            <button
              onClick={() => {
                onDelete(track);
                onClose();
              }}
              className="flex items-center justify-between rounded-md bg-surface-2/40 px-3 py-2.5 text-left text-red-400 hover:bg-red-500/10"
            >
              <span>{removeLabel ?? "Delete"}</span>
              <TrashIcon size={16} />
            </button>
          )}
        </>
      )}
    </div>
  );
}

// Reused in table rows and current-track surfaces; `alwaysVisible` keeps the
// trigger visible where there is no row-hover state.
export function TrackActionsMenu({
  alwaysVisible = false,
  ...props
}: Omit<TrackActionsProps, "onClose"> & { alwaysVisible?: boolean }) {
  const {
    open,
    mounted,
    position,
    triggerRef,
    menuRef,
    close,
    toggle,
  } = useAnchoredMenu({
    estimatedWidth: 240,
    ignoreOutsideSelector: "[data-track-actions-submenu]",
  });

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={toggle}
        aria-label="Track actions"
        aria-expanded={open}
        title="Track actions"
        className={`flex h-7 w-7 items-center justify-center rounded text-fg-muted hover:bg-surface-3 hover:text-fg ${
          open ? "bg-surface-3 text-fg" : ""
        } ${
          open || alwaysVisible
            ? ""
            : "md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100 md:group-focus-within:opacity-100"
        }`}
      >
        <EllipsisIcon size={20} />
      </button>
      <AnchoredMenu
        align="right"
        open={open}
        mounted={mounted}
        position={position}
        menuRef={menuRef}
        className={`${MENU_CHROME} z-[70] max-h-[80vh] w-60 max-w-[calc(100vw-1rem)] overflow-y-auto p-2`}
      >
        <TrackActions {...props} onClose={close} />
      </AnchoredMenu>
    </div>
  );
}

// A self-contained song-options kebab for the "current track" surfaces (queue
// header, now-playing sheet) that aren't backed by a table row. It wires
// Edit/Delete against the library and, via `playerContext`, drops the queue
// actions. The edit dialog is portalled to <body> so an ancestor's
// transform/overflow (the queue popover) can't clip it.
export function CurrentTrackKebab({
  track,
  onNavigate,
}: {
  track: TrackDTO;
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<TrackDTO | null>(null);

  // Suggested previews do not exist in the normal library-backed artist/album
  // routes yet, and every other track action is intentionally unavailable.
  if (track.isSuggested) return null;

  const remove = async (t: TrackDTO) => {
    const ok = await useConfirmStore
      .getState()
      .ask(`Delete “${t.title}”? This can’t be undone.`, { confirmLabel: "Delete" });
    if (!ok) return;
    try {
      await api(`/tracks/${t.id}`, { method: "DELETE" });
    } catch {
      useToastStore.getState().show("Couldn’t delete track");
      return;
    }
    router.refresh();
  };

  return (
    <>
      <TrackActionsMenu
        track={track}
        canEdit
        canDelete
        playerContext
        alwaysVisible
        onEdit={setEditing}
        onDelete={remove}
        onNavigate={onNavigate}
      />
      {/* Portalled to <body> so the queue popover's transform/overflow can't
          clip it. Guarded since the portal target is client-only (this kebab
          isn't server-rendered - there's no current track during SSR). */}
      {typeof document !== "undefined" &&
        createPortal(
          <EditTrackDialog
            track={editing}
            onClose={() => setEditing(null)}
            onSaved={() => router.refresh()}
          />,
          document.body,
        )}
    </>
  );
}
