"use server";

import { AuthError } from "next-auth";
import { signIn, signOut } from "@/lib/auth";
import { createUser, registerSchema } from "@/lib/users";

export type AuthFormState = { error: string | null };

export async function loginAction(
  _prev: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirectTo: "/library",
    });
    return { error: null };
  } catch (err) {
    if (err instanceof AuthError) {
      return { error: "Invalid email or password" };
    }
    throw err; // NEXT_REDIRECT on success
  }
}

export async function registerAction(
  _prev: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const parsed = registerSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const result = await createUser(parsed.data);
  if ("error" in result) return { error: result.error };

  try {
    await signIn("credentials", {
      email: parsed.data.email,
      password: parsed.data.password,
      redirectTo: "/library",
    });
    return { error: null };
  } catch (err) {
    if (err instanceof AuthError) {
      return { error: "Account created — please sign in" };
    }
    throw err;
  }
}

export async function signOutAction() {
  await signOut({ redirectTo: "/login" });
}
