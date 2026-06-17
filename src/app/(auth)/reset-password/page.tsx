"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

function ResetForm() {
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/auth/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <p className="text-sm text-fg-muted">
        This reset link is missing its token. Request a new one{" "}
        <Link href="/forgot-password" className="text-accent-bright hover:underline">
          here
        </Link>
        .
      </p>
    );
  }

  if (done) {
    return (
      <div className="flex flex-col gap-4 text-sm">
        <h2 className="font-display text-lg font-semibold">Password updated</h2>
        <p className="text-fg-muted">
          Your password has been changed and all existing sessions were signed out.
        </p>
        <Link href="/login" className="text-accent-bright hover:underline">
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <h2 className="font-display text-lg font-semibold">Choose a new password</h2>
      <Input
        type="password"
        required
        minLength={8}
        autoFocus
        placeholder="New password (8+ characters)"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {error && <p className="text-sm text-red-400">{error}</p>}
      <Button type="submit" disabled={busy}>
        {busy ? "Saving…" : "Set new password"}
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
