"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import type { FriendDTO, FriendRequestDTO } from "@/lib/types";
import InvitePanel from "@/components/InvitePanel";
import { XIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { cardClass } from "@/components/ui/Card";
import { NotificationDot } from "@/components/ui/NotificationDot";

export default function FriendsPanel({
  friends,
  requests,
  canInvite,
}: {
  friends: FriendDTO[];
  requests: FriendRequestDTO[];
  canInvite: boolean;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"friends" | "requests" | "invite">("friends");

  const incoming = requests.filter((r) => r.direction === "incoming");
  const outgoing = requests.filter((r) => r.direction === "outgoing");

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api("/friends/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      setMessage("Request sent");
      setEmail("");
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to send request");
    } finally {
      setBusy(false);
    }
  };

  const accept = async (id: string) => {
    await api(`/friends/requests/${id}`, { method: "PATCH" });
    router.refresh();
  };
  const dismiss = async (id: string) => {
    await api(`/friends/requests/${id}`, { method: "DELETE" });
    router.refresh();
  };
  const unfriend = async (friend: FriendDTO) => {
    if (!confirm(`Remove ${friend.name ?? friend.email} as a friend?`)) return;
    await api(`/friends/${friend.id}`, { method: "DELETE" });
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex gap-1 border-b border-border-subtle">
        {(
          [
            ["friends", `Friends (${friends.length})`],
            ["requests", `Requests${incoming.length ? ` (${incoming.length})` : ""}`],
            ["invite", "Invite"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setTab(value)}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-4 py-2 text-sm font-medium ${
              tab === value
                ? "border-accent text-white"
                : "border-transparent text-fg-muted hover:text-fg"
            }`}
          >
            {label}
            {value === "requests" && incoming.length > 0 && <NotificationDot />}
          </button>
        ))}
      </div>

      {tab === "friends" && (
      <>
      <form onSubmit={send} className="flex items-center gap-2">
        <Input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Add a friend by email"
          className="w-72"
        />
        <Button type="submit" disabled={busy}>
          Send request
        </Button>
        {message && <span className="text-sm text-fg-muted">{message}</span>}
      </form>
      </>
      )}

      {tab === "requests" && incoming.length === 0 && outgoing.length === 0 && (
        <p className="text-sm text-fg-subtle">No pending requests.</p>
      )}

      {tab === "requests" && incoming.length > 0 && (
        <section>
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase text-fg-subtle">
            Incoming requests
            <NotificationDot />
          </h2>
          <ul className="flex flex-col gap-2">
            {incoming.map((r) => (
              <li
                key={r.id}
                className="flex items-center gap-3 rounded-md border border-border-subtle bg-surface-1 px-4 py-2"
              >
                <span className="flex-1 text-sm">
                  {r.user.name ?? r.user.email}
                  <span className="ml-2 text-xs text-fg-subtle">{r.user.email}</span>
                </span>
                <Button size="sm" onClick={() => accept(r.id)}>
                  Accept
                </Button>
                <button
                  onClick={() => dismiss(r.id)}
                  className="rounded-md px-3 py-1 text-xs text-fg-muted hover:text-red-400"
                >
                  Decline
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tab === "requests" && outgoing.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase text-fg-subtle">
            Sent requests
          </h2>
          <ul className="flex flex-col gap-2">
            {outgoing.map((r) => (
              <li
                key={r.id}
                className="flex items-center gap-3 rounded-md border border-border-subtle bg-surface-1 px-4 py-2"
              >
                <span className="flex-1 text-sm">
                  {r.user.name ?? r.user.email}
                  <span className="ml-2 text-xs text-fg-subtle">pending</span>
                </span>
                <button
                  onClick={() => dismiss(r.id)}
                  className="rounded-md px-3 py-1 text-xs text-fg-muted hover:text-red-400"
                >
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tab === "invite" && <InvitePanel canInvite={canInvite} />}

      {tab === "friends" && (
      <section>
        {friends.length === 0 ? (
          <p className="text-sm text-fg-subtle">
            No friends yet. Friends automatically share their libraries with each other.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {friends.map((f, i) => (
              <li
                key={f.id}
                style={{ animationDelay: `${Math.min(i, 8) * 0.03}s` }}
                className={`flex animate-fade-in-up items-center gap-3 p-4 ${cardClass}`}
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/15 font-display text-lg font-semibold text-accent-bright">
                  {(f.name ?? f.email).charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/discover/${f.id}`}
                    className="block truncate text-sm font-medium hover:underline"
                  >
                    {f.name ?? f.email}
                  </Link>
                  <p className="truncate text-xs text-fg-subtle">{f.email}</p>
                </div>
                <button
                  onClick={() => unfriend(f)}
                  title="Unfriend"
                  className="text-fg-subtle hover:text-red-400"
                >
                  <XIcon size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      )}
    </div>
  );
}
