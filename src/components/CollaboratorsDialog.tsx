"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { FriendDTO } from "@/lib/types";
import Dialog from "@/components/Dialog";
import { Button } from "@/components/ui/Button";

/** Circular initial badge, matching the friend rows elsewhere. */
function Avatar({ name }: { name: string }) {
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/15 font-semibold text-accent-bright">
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

// Owner-only editor for a playlist's collaborators: add/remove from the friend
// list. Stays mounted so the Dialog can animate out; the body mounts per open
// so the friend list reloads fresh each time.
export default function CollaboratorsDialog({
  playlistId,
  collaborators,
  open,
  onClose,
  onChanged,
}: {
  playlistId: string;
  collaborators: FriendDTO[];
  open: boolean;
  onClose: () => void;
  /** Called after any add/remove so the page can refresh its server data. */
  onChanged: () => void;
}) {
  return (
    <Dialog title="Collaborators" open={open} onClose={onClose}>
      {open && (
        <CollaboratorsBody
          playlistId={playlistId}
          initial={collaborators}
          onChanged={onChanged}
        />
      )}
    </Dialog>
  );
}

function CollaboratorsBody({
  playlistId,
  initial,
  onChanged,
}: {
  playlistId: string;
  initial: FriendDTO[];
  onChanged: () => void;
}) {
  const [friends, setFriends] = useState<FriendDTO[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [collabIds, setCollabIds] = useState<Set<string>>(
    () => new Set(initial.map((c) => c.id))
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<FriendDTO[]>("/friends")
      .then((f) => !cancelled && setFriends(f))
      .catch(() => {
        if (!cancelled) {
          setFriends([]);
          setLoadFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = async (friend: FriendDTO) => {
    if (busyId) return;
    const isCollab = collabIds.has(friend.id);
    setBusyId(friend.id);
    setError(null);
    try {
      if (isCollab) {
        await api(`/playlists/${playlistId}/collaborators?userId=${friend.id}`, {
          method: "DELETE",
        });
        setCollabIds((prev) => {
          const next = new Set(prev);
          next.delete(friend.id);
          return next;
        });
      } else {
        await api(`/playlists/${playlistId}/collaborators`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: friend.id }),
        });
        setCollabIds((prev) => new Set(prev).add(friend.id));
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn’t update collaborator");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-fg-muted">
        Friends you add can add, remove, and reorder tracks, rename the playlist,
        and change its cover.
      </p>
      <div className="max-h-80 overflow-y-auto rounded-md border border-border-subtle">
        {friends === null && <p className="p-4 text-sm text-fg-muted">Loading…</p>}
        {friends?.length === 0 && (
          <p className="p-4 text-sm text-fg-muted">
            {loadFailed
              ? "Couldn’t load your friends - check your connection."
              : "Add friends first to collaborate on playlists."}
          </p>
        )}
        {friends?.map((f) => {
          const isCollab = collabIds.has(f.id);
          return (
            <div
              key={f.id}
              className="flex items-center gap-3 border-b border-border-subtle/60 px-3 py-2 text-sm last:border-b-0"
            >
              <Avatar name={f.name} />
              <span className="min-w-0 flex-1 truncate font-medium">{f.name}</span>
              <Button
                variant={isCollab ? "outline" : "secondary"}
                pill
                onClick={() => toggle(f)}
                disabled={busyId === f.id}
              >
                {busyId === f.id ? "…" : isCollab ? "Remove" : "Add"}
              </Button>
            </div>
          );
        })}
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
