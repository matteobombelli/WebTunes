"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

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
        <h2 className="font-display text-lg font-semibold">Check your email</h2>
        <p className="text-fg-muted">
          If an account exists for <span className="text-fg">{email}</span>,
          a reset link is on its way. It expires in 1 hour.
        </p>
        <Link href="/login" className="text-accent-bright hover:text-white">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <h2 className="font-display text-lg font-semibold">Reset password</h2>
      <p className="text-sm text-fg-muted">
        Enter your account email and we&apos;ll send you a reset link.
      </p>
      <Input
        name="email"
        type="email"
        required
        autoFocus
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      {error && <p className="text-sm text-red-400">{error}</p>}
      <Button type="submit" disabled={busy}>
        {busy ? "Sending…" : "Send reset link"}
      </Button>
      <p className="text-center text-sm text-fg-muted">
        <Link href="/login" className="text-accent-bright hover:text-white">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
