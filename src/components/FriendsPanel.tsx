"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import type { FriendDTO, FriendRequestDTO } from "@/lib/types";

export default function FriendsPanel({
  friends,
  requests,
}: {
  friends: FriendDTO[];
  requests: FriendRequestDTO[];
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"friends" | "requests">("friends");

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
      <div className="flex gap-1 border-b border-neutral-800">
        {(
          [
            ["friends", `Friends (${friends.length})`],
            ["requests", `Requests${incoming.length ? ` (${incoming.length})` : ""}`],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setTab(value)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${
              tab === value
                ? "border-emerald-500 text-white"
                : "border-transparent text-neutral-400 hover:text-neutral-200"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "friends" && (
      <>
      <form onSubmit={send} className="flex items-center gap-2">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Add a friend by email"
          className="w-72 rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm outline-none focus:border-emerald-500"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          Send request
        </button>
        {message && <span className="text-sm text-neutral-400">{message}</span>}
      </form>
      </>
      )}

      {tab === "requests" && incoming.length === 0 && outgoing.length === 0 && (
        <p className="text-sm text-neutral-500">No pending requests.</p>
      )}

      {tab === "requests" && incoming.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase text-neutral-500">
            Incoming requests
          </h2>
          <ul className="flex flex-col gap-2">
            {incoming.map((r) => (
              <li
                key={r.id}
                className="flex items-center gap-3 rounded-md border border-neutral-800 bg-neutral-900 px-4 py-2"
              >
                <span className="flex-1 text-sm">
                  {r.user.name ?? r.user.email}
                  <span className="ml-2 text-xs text-neutral-500">{r.user.email}</span>
                </span>
                <button
                  onClick={() => accept(r.id)}
                  className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-500"
                >
                  Accept
                </button>
                <button
                  onClick={() => dismiss(r.id)}
                  className="rounded-md px-3 py-1 text-xs text-neutral-400 hover:text-red-400"
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
          <h2 className="mb-2 text-sm font-semibold uppercase text-neutral-500">
            Sent requests
          </h2>
          <ul className="flex flex-col gap-2">
            {outgoing.map((r) => (
              <li
                key={r.id}
                className="flex items-center gap-3 rounded-md border border-neutral-800 bg-neutral-900 px-4 py-2"
              >
                <span className="flex-1 text-sm">
                  {r.user.name ?? r.user.email}
                  <span className="ml-2 text-xs text-neutral-500">pending</span>
                </span>
                <button
                  onClick={() => dismiss(r.id)}
                  className="rounded-md px-3 py-1 text-xs text-neutral-400 hover:text-red-400"
                >
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tab === "friends" && (
      <section>
        {friends.length === 0 ? (
          <p className="text-sm text-neutral-500">
            No friends yet. Friends automatically share their libraries with each other.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {friends.map((f) => (
              <li
                key={f.id}
                className="flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-800 text-lg">
                  {(f.name ?? f.email).charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/friends/${f.id}`}
                    className="block truncate text-sm font-medium hover:underline"
                  >
                    {f.name ?? f.email}
                  </Link>
                  <p className="truncate text-xs text-neutral-500">{f.email}</p>
                </div>
                <button
                  onClick={() => unfriend(f)}
                  title="Unfriend"
                  className="text-xs text-neutral-500 hover:text-red-400"
                >
                  ✕
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
