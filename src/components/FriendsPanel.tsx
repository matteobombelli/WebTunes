"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type {
  FriendDTO,
  FriendRequestDTO,
  FriendSuggestionDTO,
} from "@/lib/types";
import InvitePanel from "@/components/InvitePanel";
import { XIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { cardClass } from "@/components/ui/Card";
import { NotificationDot } from "@/components/ui/NotificationDot";

export default function FriendsPanel({
  friends,
  requests,
  suggestions,
  canInvite,
}: {
  friends: FriendDTO[];
  requests: FriendRequestDTO[];
  suggestions: FriendSuggestionDTO[];
  canInvite: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  // Search results stamped with the query they belong to, so `results` and
  // `searching` are derived during render (no synchronous setState in the
  // effect — only the deferred fetch writes state).
  const [search, setSearch] = useState<{ q: string; results: FriendDTO[] }>({
    q: "",
    results: [],
  });
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [tab, setTab] = useState<"friends" | "requests" | "invite">("friends");
  // Ids we've just sent a request to, so suggestions disappear immediately
  // (router.refresh() then drops them server-side once the request exists).
  const [requestedIds, setRequestedIds] = useState<Set<string>>(new Set());

  const incoming = requests.filter((r) => r.direction === "incoming");
  const outgoing = requests.filter((r) => r.direction === "outgoing");
  const visibleSuggestions = suggestions.filter((s) => !requestedIds.has(s.id));

  const trimmedQuery = query.trim();
  const results = search.q === trimmedQuery ? search.results : [];
  const searching = trimmedQuery !== "" && search.q !== trimmedQuery;

  // Debounced username search. Aborts the in-flight request when the query
  // changes so stale results can't clobber fresh ones.
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const found = await api<FriendDTO[]>(
          `/users/search?q=${encodeURIComponent(q)}`,
          { signal: controller.signal }
        );
        setSearch({ q, results: found });
      } catch {
        if (!controller.signal.aborted) setSearch({ q, results: [] });
      }
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query]);

  const sendRequest = async (target: FriendDTO) => {
    setSendingId(target.id);
    setMessage(null);
    try {
      await api("/friends/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: target.id }),
      });
      setMessage(`Request sent to ${target.name}`);
      setSearch((s) => ({
        ...s,
        results: s.results.filter((r) => r.id !== target.id),
      }));
      setRequestedIds((prev) => new Set(prev).add(target.id));
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to send request");
    } finally {
      setSendingId(null);
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
    if (!confirm(`Remove ${friend.name} as a friend?`)) return;
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
        <div className="flex flex-col gap-2">
          <Input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find friends by username"
            aria-label="Search users by username"
            className="w-72"
          />
          {message && <span className="text-sm text-fg-muted">{message}</span>}
          {query.trim() && (
            <ul className="flex max-w-md flex-col gap-1">
              {results.map((u) => (
                <li
                  key={u.id}
                  className="flex items-center gap-3 rounded-md border border-border-subtle bg-surface-1 px-4 py-2"
                >
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent/15 text-sm font-semibold text-accent-bright">
                    {u.name.charAt(0).toUpperCase()}
                  </div>
                  <span className="flex-1 truncate text-sm">{u.name}</span>
                  <Button
                    size="sm"
                    disabled={sendingId === u.id}
                    onClick={() => sendRequest(u)}
                  >
                    {sendingId === u.id ? "Sending…" : "Add"}
                  </Button>
                </li>
              ))}
              {!searching && results.length === 0 && (
                <li className="px-1 text-sm text-fg-subtle">No users found.</li>
              )}
            </ul>
          )}
        </div>
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
                <span className="flex-1 truncate text-sm">{r.user.name}</span>
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
                  {r.user.name}
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
                className={`relative flex animate-fade-in-up items-center gap-3 p-4 ${cardClass}`}
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/15 font-display text-lg font-semibold text-accent-bright">
                  {f.name.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/discover/${f.id}`}
                    className="block truncate text-sm font-medium after:absolute after:inset-0 hover:text-accent-bright"
                  >
                    {f.name}
                  </Link>
                </div>
                <button
                  onClick={() => unfriend(f)}
                  title="Unfriend"
                  className="relative z-10 text-fg-subtle hover:text-red-400"
                >
                  <XIcon size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      )}

      {tab === "friends" && visibleSuggestions.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase text-fg-subtle">
            You might know
          </h2>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visibleSuggestions.map((s) => (
              <li
                key={s.id}
                className={`flex items-center gap-3 p-4 ${cardClass}`}
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/15 font-display text-lg font-semibold text-accent-bright">
                  {s.name.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {s.name}
                  </span>
                  <span className="text-xs text-fg-subtle">
                    {s.mutualCount} mutual friend
                    {s.mutualCount === 1 ? "" : "s"}
                  </span>
                </div>
                <Button
                  size="sm"
                  disabled={sendingId === s.id}
                  onClick={() => sendRequest(s)}
                >
                  {sendingId === s.id ? "Sending…" : "Add"}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
