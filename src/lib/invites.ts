import { randomBytes } from "node:crypto";
import { hash } from "bcryptjs";
import { and, desc, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db, uniqueViolationConstraint } from "@/db";
import { friendships, invites, users } from "@/db/schema";
import type { InviteDTO } from "@/lib/types";
import {
  isNameTaken,
  USERNAME_TAKEN_MESSAGE,
  USERNAME_UNIQUE_INDEX,
  type RegisterInput,
} from "@/lib/users";

// Registration is invite-only. An invite row is an unguessable plaintext
// capability: anyone holding an unused, unexpired token can create exactly one
// account at /register?invite=<token>, then gets auto-friended with the inviter.
// Multiple concurrent links per user; each single-use (used_at is the consumed
// flag — robust even if the redeemer is later deleted). Mirrors lib/shares.ts.
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Hard cap on TOTAL platform accounts (counts the demo accounts too).
export const MAX_USERS = 100;

// These accounts may use the app but can't send invites.
export const INVITE_BLOCKED_EMAILS = new Set([
  "demo1@demo.demo",
  "demo2@demo.demo",
]);

// Constant key for pg_advisory_xact_lock so concurrent registrations serialize
// around the user-count cap check (the count+insert would otherwise race).
const REGISTRATION_LOCK_KEY = 918_273_645;

function toDTO(row: {
  token: string;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  usedByName?: string | null;
}): InviteDTO {
  return {
    token: row.token,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    usedByName: row.usedAt ? row.usedByName ?? "a former member" : null,
  };
}

/** Mint a fresh single-use invite link for a user. */
export async function createInvite(userId: string): Promise<InviteDTO> {
  const token = randomBytes(18).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const [row] = await db
    .insert(invites)
    .values({ inviterId: userId, token, expiresAt })
    .returning({
      token: invites.token,
      createdAt: invites.createdAt,
      expiresAt: invites.expiresAt,
      usedAt: invites.usedAt,
    });
  return toDTO(row);
}

/**
 * A user's invite links for the Invite tab: every redeemed link (kept as
 * history, "used by <name>") plus every still-active unused one. Expired-unused
 * links are dead clutter, so they're omitted (and swept by the purge script).
 * Newest first.
 */
export async function listInvitesFor(userId: string): Promise<InviteDTO[]> {
  const rows = await db
    .select({
      token: invites.token,
      createdAt: invites.createdAt,
      expiresAt: invites.expiresAt,
      usedAt: invites.usedAt,
      usedByName: users.name,
    })
    .from(invites)
    .leftJoin(users, eq(users.id, invites.usedByUserId))
    .where(
      and(
        eq(invites.inviterId, userId),
        // Keep redeemed links (history) OR unused-but-still-active ones.
        or(isNotNull(invites.usedAt), gt(invites.expiresAt, new Date()))
      )
    )
    .orderBy(desc(invites.createdAt));
  return rows.map(toDTO);
}

/** The inviter's display name for a still-valid token, or null. Gates the page. */
export async function getInviteByToken(
  token: string
): Promise<{ inviterName: string } | null> {
  const [row] = await db
    .select({ name: users.name })
    .from(invites)
    .innerJoin(users, eq(users.id, invites.inviterId))
    .where(
      and(
        eq(invites.token, token),
        isNull(invites.usedAt),
        gt(invites.expiresAt, new Date())
      )
    );
  if (!row) return null;
  return { inviterName: row.name };
}

export type RegisterInvitedResult =
  | { user: { id: string; email: string; name: string | null } }
  | { error: string };

/**
 * Create an account from a valid invite, enforcing the 100-user cap and
 * auto-friending the inviter — all in one transaction so a failure never
 * half-consumes the invite or orphans a user. `input` is already zod-validated.
 */
export async function registerInvitedUser(
  input: RegisterInput & { token: string }
): Promise<RegisterInvitedResult> {
  // Friendly pre-checks (invite untouched); the unique indexes are the race
  // guards. Both email and username are unique.
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.email));
  if (existing) return { error: "An account with that email already exists" };
  if (await isNameTaken(input.name)) return { error: USERNAME_TAKEN_MESSAGE };

  const passwordHash = await hash(input.password, 12); // slow — keep out of the tx
  try {
    return await db.transaction(async (tx) => {
      // Serialize registrations so the count + insert below can't race the cap.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${REGISTRATION_LOCK_KEY})`
      );

      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(users);
      if (count >= MAX_USERS) {
        return {
          error: "WebTunes is full — the 100-account limit has been reached.",
        };
      }

      // Claim the invite atomically (single-use). Matches 0 rows when the token
      // is unknown, already redeemed, or expired.
      const [consumed] = await tx
        .update(invites)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(invites.token, input.token),
            isNull(invites.usedAt),
            gt(invites.expiresAt, new Date())
          )
        )
        .returning({ inviterId: invites.inviterId });
      if (!consumed) {
        return { error: "This invite link is invalid, already used, or expired." };
      }

      const [user] = await tx
        .insert(users)
        .values({ name: input.name, email: input.email, passwordHash })
        .returning({ id: users.id, email: users.email, name: users.name });

      // Record who redeemed it (history) and auto-friend the inviter — one
      // accepted row covers both directions; onConflictDoNothing is just safety.
      await tx
        .update(invites)
        .set({ usedByUserId: user.id })
        .where(eq(invites.token, input.token));
      await tx
        .insert(friendships)
        .values({
          requesterId: consumed.inviterId,
          addresseeId: user.id,
          status: "accepted",
          respondedAt: new Date(),
        })
        .onConflictDoNothing();

      return { user };
    });
  } catch (err) {
    // A concurrent registration slipped the same email or username past the
    // pre-check; the tx rolled back, so the invite is still unused.
    const constraint = uniqueViolationConstraint(err);
    if (constraint === USERNAME_UNIQUE_INDEX) {
      return { error: USERNAME_TAKEN_MESSAGE };
    }
    if (constraint !== null) {
      return { error: "An account with that email already exists" };
    }
    throw err;
  }
}
