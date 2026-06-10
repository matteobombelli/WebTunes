"use client";

import { useActionState } from "react";
import Link from "next/link";
import { registerAction, type AuthFormState } from "../actions";

const initialState: AuthFormState = { error: null };

export default function RegisterPage() {
  const [state, formAction, pending] = useActionState(
    registerAction,
    initialState
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Create account</h2>
      <input
        name="name"
        type="text"
        required
        placeholder="Name"
        autoComplete="name"
        className="rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm outline-none focus:border-emerald-500"
      />
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
        minLength={8}
        placeholder="Password (8+ characters)"
        autoComplete="new-password"
        className="rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm outline-none focus:border-emerald-500"
      />
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
      >
        {pending ? "Creating…" : "Create account"}
      </button>
      <p className="text-center text-sm text-neutral-400">
        Have an account?{" "}
        <Link href="/login" className="text-emerald-400 hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
