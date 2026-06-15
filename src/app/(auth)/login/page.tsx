"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { loginAction, type AuthFormState } from "../actions";

const initialState: AuthFormState = { error: null };

function ResendVerification({ email }: { email: string }) {
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");

  const resend = async () => {
    setStatus("sending");
    try {
      await api("/auth/verify/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
    } finally {
      setStatus("sent");
    }
  };

  return (
    <div className="rounded-md border border-amber-700/50 bg-amber-950/30 p-3 text-sm text-amber-200">
      <p>Please verify your email before signing in.</p>
      {status === "sent" ? (
        <p className="mt-1 text-amber-300/80">
          If that account needs verifying, a new link is on its way.
        </p>
      ) : (
        <button
          type="button"
          onClick={resend}
          disabled={status === "sending"}
          className="mt-1 font-semibold underline-offset-2 hover:underline disabled:opacity-50"
        >
          {status === "sending" ? "Sending…" : "Resend verification email"}
        </button>
      )}
    </div>
  );
}

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(
    loginAction,
    initialState
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Sign in</h2>
      <input
        name="email"
        type="email"
        required
        placeholder="Email"
        autoComplete="email"
        className="rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm outline-none focus:border-emerald-500"
      />
      <input
        name="password"
        type="password"
        required
        placeholder="Password"
        autoComplete="current-password"
        className="rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm outline-none focus:border-emerald-500"
      />
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
      {state.unverifiedEmail && (
        <ResendVerification email={state.unverifiedEmail} />
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
      <p className="text-center text-sm text-neutral-400">
        No account?{" "}
        <Link href="/register" className="text-emerald-400 hover:underline">
          Register
        </Link>
      </p>
      <p className="-mt-2 text-center text-sm">
        <Link
          href="/forgot-password"
          className="text-neutral-400 underline-offset-2 hover:text-emerald-400 hover:underline"
        >
          Forgot password?
        </Link>
      </p>
    </form>
  );
}
