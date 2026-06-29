import { and, eq, ilike, ne, sql } from "drizzle-orm";
import { cache } from "react";
import { z } from "zod";
import { db, uniqueViolationConstraint } from "@/db";
import { users } from "@/db/schema";
import type { FriendDTO } from "@/lib/types";

// Shared so the register form and the in-app rename (PATCH /api/account) can't
// validate the username differently. `name` is the public username — kept
// freeform (any characters) but unique case-insensitively (see below).
export const nameSchema = z
  .string()
  .trim()
  .min(1, "Username is required")
  .max(100);

// Name of the `UNIQUE (lower(name))` index (raw SQL — drizzle/0020). Used to
// tell a username collision apart from the email one in a 23505.
export const USERNAME_UNIQUE_INDEX = "users_name_lower_idx";
export const USERNAME_TAKEN_MESSAGE = "That username is taken";

/** True when another user already holds this name (case-insensitive). */
export async function isNameTaken(
  name: string,
  exceptUserId?: string
): Promise<boolean> {
  const sameName = sql`lower(${users.name}) = lower(${name})`;
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(exceptUserId ? and(sameName, ne(users.id, exceptUserId)) : sameName)
    .limit(1);
  return !!row;
}

// Escape LIKE wildcards so a query like "a_b" matches literally, not as a
// pattern (default escape char is backslash).
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Users whose username contains `query` (case-insensitive), for the friend
 * search. Excludes the searcher; never returns email. Capped at 10.
 */
export async function searchUsers(
  viewerId: string,
  query: string
): Promise<FriendDTO[]> {
  const q = query.trim();
  if (!q) return [];
  return db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(ne(users.id, viewerId), ilike(users.name, `%${escapeLike(q)}%`)))
    .orderBy(users.name)
    .limit(10);
}

export const registerSchema = z.object({
  name: nameSchema,
  email: z.string().trim().toLowerCase().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export type RegisterInput = z.infer<typeof registerSchema>;

// Account creation lives in lib/invites.ts (registerInvitedUser): registration
// is invite-only, so there's no open createUser path anymore.

export type UpdateNameResult = { name: string } | { error: string };

/**
 * Rename the signed-in user. Usernames are unique case-insensitively: returns
 * `{ error }` (not a throw) when the chosen name is taken — the pre-check is
 * friendly, the unique index is the race guard.
 */
export async function updateDisplayName(
  userId: string,
  name: string
): Promise<UpdateNameResult> {
  if (await isNameTaken(name, userId)) {
    return { error: USERNAME_TAKEN_MESSAGE };
  }
  try {
    const [row] = await db
      .update(users)
      .set({ name })
      .where(eq(users.id, userId))
      .returning({ name: users.name });
    return { name: row.name };
  } catch (err) {
    if (uniqueViolationConstraint(err) === USERNAME_UNIQUE_INDEX) {
      return { error: USERNAME_TAKEN_MESSAGE };
    }
    throw err;
  }
}

/** A user's username, or null if no such user. */
export async function getDisplayName(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, userId));
  return row ? row.name : null;
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
