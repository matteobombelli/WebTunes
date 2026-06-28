"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { BASE_PATH } from "@/lib/base-path";
import type { InviteDTO } from "@/lib/types";
import { useToastStore } from "@/stores/toast";
import { Button } from "@/components/ui/Button";

function inviteUrl(token: string): string {
  return `${window.location.origin}${BASE_PATH}/register?invite=${token}`;
}

function daysLeft(expiresAt: string): number {
  return Math.max(
    0,
    Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000)
  );
}

/**
 * The Discover → Friends → Invite tab. Lists this user's invite links (active
 * unused ones + redeemed history) and mints new ones. Each link is single-use
 * and expires after 7 days; whoever signs up through it is auto-friended.
 */
export default function InvitePanel({ canInvite }: { canInvite: boolean }) {
  const [invites, setInvites] = useState<InviteDTO[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!canInvite) return;
    let active = true;
    api<InviteDTO[]>("/invites")
      .then((rows) => active && setInvites(rows))
      .catch(() => active && setInvites([]));
    return () => {
      active = false;
    };
  }, [canInvite]);

  const generate = async () => {
    setBusy(true);
    try {
      const created = await api<InviteDTO>("/invites", { method: "POST" });
      setInvites((prev) => [created, ...(prev ?? [])]);
    } catch (err) {
      useToastStore
        .getState()
        .show(err instanceof Error ? err.message : "Couldn’t create link");
    } finally {
      setBusy(false);
    }
  };

  const copy = (token: string) => {
    navigator.clipboard.writeText(inviteUrl(token)).then(
      () => useToastStore.getState().show("Copied invite link to clipboard!"),
      () => useToastStore.getState().show("Couldn’t copy link")
    );
  };

  if (!canInvite) {
    return (
      <p className="text-sm text-fg-subtle">Demo accounts can’t send invites.</p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-md text-sm text-fg-muted">
          Each link lets one friend create an account and auto-friends you. Links
          work once and expire after 7 days.
        </p>
        <Button onClick={generate} disabled={busy}>
          {busy ? "Generating…" : "Generate new link"}
        </Button>
      </div>

      {invites === null ? (
        <p className="text-sm text-fg-subtle">Loading…</p>
      ) : invites.length === 0 ? (
        <p className="text-sm text-fg-subtle">
          No invite links yet. Generate one to invite a friend.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {invites.map((inv) => (
            <li
              key={inv.token}
              className="flex items-center gap-3 rounded-md border border-border-subtle bg-surface-1 px-4 py-2"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted">
                {inviteUrl(inv.token)}
              </span>
              {inv.usedByName ? (
                <span className="shrink-0 text-xs text-fg-subtle">
                  used by {inv.usedByName}
                </span>
              ) : (
                <>
                  <span className="shrink-0 text-xs text-fg-subtle">
                    {daysLeft(inv.expiresAt)}d left
                  </span>
                  <Button size="sm" onClick={() => copy(inv.token)}>
                    Copy
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
