import { hash } from "bcryptjs";
import { eq } from "drizzle-orm";
import { cache } from "react";
import { z } from "zod";
import { db, isUniqueViolation } from "@/db";
import { users } from "@/db/schema";

// Shared so the register form and the in-app rename (PATCH /api/account) can't
// validate the display name differently.
export const nameSchema = z.string().trim().min(1, "Name is required").max(100);

export const registerSchema = z.object({
  name: nameSchema,
  email: z.string().trim().toLowerCase().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export type RegisterInput = z.infer<typeof registerSchema>;

export type CreateUserResult =
  | { user: { id: string; email: string; name: string | null } }
  | { error: string };

export async function createUser(
  input: RegisterInput
): Promise<CreateUserResult> {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.email));
  if (existing) {
    return { error: "An account with that email already exists" };
  }
  const passwordHash = await hash(input.password, 12);
  try {
    const [user] = await db
      .insert(users)
      .values({ name: input.name, email: input.email, passwordHash })
      .returning({ id: users.id, email: users.email, name: users.name });
    return { user };
  } catch (err) {
    // Concurrent registration slipped past the existence check.
    if (isUniqueViolation(err)) {
      return { error: "An account with that email already exists" };
    }
    throw err;
  }
}

/** Update the signed-in user's display name; returns the stored value. */
export async function updateDisplayName(
  userId: string,
  name: string
): Promise<string> {
  const [row] = await db
    .update(users)
    .set({ name })
    .where(eq(users.id, userId))
    .returning({ name: users.name });
  return row.name!; // non-null: we just set it
}

/** A user's display name (falling back to email), or null if no such user. */
export async function getDisplayName(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  if (!row) return null;
  return row.name ?? row.email;
}

export type UserSettings = {
  hideFriendDuplicates: boolean;
  normalizeVolume: boolean;
  similarVariation: number;
  similarDrift: boolean;
};

// Per-request cache(): read once even though the (app) layout and the page it
// renders both call it on the same request (no effect across requests, and a
// PATCH that mutates settings runs in its own request).
export const getUserSettings = cache(async function getUserSettings(
  userId: string
): Promise<UserSettings> {
  const [row] = await db
    .select({
      hideFriendDuplicates: users.hideFriendDuplicates,
      normalizeVolume: users.normalizeVolume,
      similarVariation: users.similarVariation,
      similarDrift: users.similarDrift,
    })
    .from(users)
    .where(eq(users.id, userId));
  return (
    row ?? {
      hideFriendDuplicates: true,
      normalizeVolume: true,
      similarVariation: 3,
      similarDrift: true,
    }
  );
});

export async function updateUserSettings(
  userId: string,
  settings: Partial<UserSettings>
): Promise<UserSettings> {
  const [row] = await db
    .update(users)
    .set(settings)
    .where(eq(users.id, userId))
    .returning({
      hideFriendDuplicates: users.hideFriendDuplicates,
      normalizeVolume: users.normalizeVolume,
      similarVariation: users.similarVariation,
      similarDrift: users.similarDrift,
    });
  return row;
}
