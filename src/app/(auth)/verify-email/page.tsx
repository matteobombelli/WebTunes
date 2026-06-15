"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

type Status = "verifying" | "done" | "error";

function VerifyEmail() {
  const token = useSearchParams().get("token") ?? "";
  const [status, setStatus] = useState<Status>(token ? "verifying" : "error");
  const [error, setError] = useState<string | null>(null);
  // React StrictMode double-invokes effects in dev; guard so the single-use
  // token isn't consumed twice (the second call would then report "expired").
  const ran = useRef(false);

  useEffect(() => {
    if (!token || ran.current) return;
    ran.current = true;
    api("/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(() => setStatus("done"))
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Verification failed");
        setStatus("error");
      });
  }, [token]);

  if (status === "verifying") {
    return <p className="text-sm text-neutral-400">Verifying your email…</p>;
  }

  if (status === "done") {
    return (
      <div className="flex flex-col gap-4 text-sm">
        <h2 className="text-lg font-semibold">Email verified</h2>
        <p className="text-neutral-400">
          Your account is now active. You can sign in.
        </p>
        <Link href="/login" className="text-emerald-400 hover:underline">
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 text-sm">
      <h2 className="text-lg font-semibold">Verification failed</h2>
      <p className="text-neutral-400">
        {error ?? "This verification link is missing its token."}
      </p>
      <Link href="/login" className="text-emerald-400 hover:underline">
        Back to sign in
      </Link>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmail />
    </Suspense>
  );
}
