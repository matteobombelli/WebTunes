"use client";

import { useActionState } from "react";
import Link from "next/link";
import { registerAction, type AuthFormState } from "../actions";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

const initialState: AuthFormState = { error: null };

export default function RegisterForm({
  token,
  inviterName,
}: {
  token: string;
  inviterName: string;
}) {
  const [state, formAction, pending] = useActionState(
    registerAction,
    initialState
  );

  if (state.notice) {
    return (
      <div className="flex flex-col gap-4 text-sm">
        <h2 className="font-display text-lg font-semibold">Check your email</h2>
        <p className="text-fg-muted">{state.notice}</p>
        <Link href="/login" className="text-accent-bright hover:underline">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <h2 className="font-display text-lg font-semibold">Create account</h2>
      <p className="text-sm text-fg-muted">
        You&apos;ve been invited by{" "}
        <span className="font-medium text-fg">{inviterName}</span>. You&apos;ll
        become friends automatically.
      </p>
      <input type="hidden" name="invite" value={token} />
      <Input name="name" type="text" required placeholder="Name" autoComplete="name" />
      <Input
        name="email"
        type="email"
        required
        placeholder="Email"
        autoComplete="email"
      />
      <Input
        name="password"
        type="password"
        required
        minLength={8}
        placeholder="Password (8+ characters)"
        autoComplete="new-password"
      />
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create account"}
      </Button>
      <p className="text-center text-sm text-fg-muted">
        Have an account?{" "}
        <Link href="/login" className="text-accent-bright hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
