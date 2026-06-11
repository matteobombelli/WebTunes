"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/auth/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <div className="flex flex-col gap-4 text-sm">
        <h2 className="text-lg font-semibold">Check your email</h2>
        <p className="text-neutral-400">
          If an account exists for <span className="text-neutral-200">{email}</span>,
          a reset link is on its way. It expires in 1 hour.
        </p>
        <Link href="/login" className="text-emerald-400 hover:underline">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Reset password</h2>
      <p className="text-sm text-neutral-400">
        Enter your account email and we&apos;ll send you a reset link.
      </p>
      <input
        name="email"
        type="email"
        required
        autoFocus
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm outline-none focus:border-emerald-500"
      />
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
      >
        {busy ? "Sending…" : "Send reset link"}
      </button>
      <p className="text-center text-sm text-neutral-400">
        <Link href="/login" className="text-emerald-400 hover:underline">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
