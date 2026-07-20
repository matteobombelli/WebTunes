import { createHash, randomBytes, randomInt } from "node:crypto";
import { and, desc, eq, gt, isNotNull, isNull, lte, or } from "drizzle-orm";
import { db } from "@/db";
import { extensionPairCodes, extensionTokens, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth-helpers";
import type { ExtensionTokenDTO } from "@/lib/types";

// Pairing flow for the WebTunes Importer browser extension: Settings mints a
// short-lived code (createPairingCode), the user types it into the extension,
// and the extension redeems it (redeemPairingCode) for a long-lived bearer
// token it sends as `Authorization: Bearer <token>` on uploads. Both secrets
// are stored hashed, mirroring the password-reset/verification tokens - never
// the plaintext.

export const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
const PAIR_CODE_LENGTH = 8;
// No 0/O/1/I/L, so a code survives being read aloud or retyped.
const PAIR_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const TOKEN_PREFIX = "wtx_";
const MAX_LABEL_LENGTH = 80;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Uppercases and strips the separators people add when copying codes. */
function normalizePairCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, "");
}

/**
 * Mint a fresh single-use pairing code for the signed-in user. Sweeps the
 * user's spent/expired codes first (same opportunistic-cleanup pattern as
 * invites) so repeated "Generate code" clicks don't accumulate rows.
 */
export async function createPairingCode(
  userId: string
): Promise<{ code: string; expiresAt: string }> {
  await db
    .delete(extensionPairCodes)
    .where(
      and(
        eq(extensionPairCodes.userId, userId),
        or(
          lte(extensionPairCodes.expiresAt, new Date()),
          isNotNull(extensionPairCodes.usedAt)
        )
      )
    );

  let code = "";
  for (let i = 0; i < PAIR_CODE_LENGTH; i++) {
    code += PAIR_CODE_ALPHABET[randomInt(PAIR_CODE_ALPHABET.length)];
  }
  const expiresAt = new Date(Date.now() + PAIR_CODE_TTL_MS);
  await db.insert(extensionPairCodes).values({
    codeHash: sha256(code),
    userId,
    expiresAt,
  });
  return { code, expiresAt: expiresAt.toISOString() };
}

export type RedeemResult = {
  token: string;
  user: { id: string; name: string | null };
};

/**
 * Redeem a pairing code for a long-lived import token. Consumes the code
 * atomically (single-use, expiry-checked in the UPDATE) so two concurrent
 * redeems can't both succeed. Returns null for an unknown/used/expired code.
 */
export async function redeemPairingCode(
  rawCode: string,
  label: string | null
): Promise<RedeemResult | null> {
  const codeHash = sha256(normalizePairCode(rawCode));
  const [consumed] = await db
    .update(extensionPairCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(extensionPairCodes.codeHash, codeHash),
        isNull(extensionPairCodes.usedAt),
        gt(extensionPairCodes.expiresAt, new Date())
      )
    )
    .returning({ userId: extensionPairCodes.userId });
  if (!consumed) return null;

  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  await db.insert(extensionTokens).values({
    userId: consumed.userId,
    tokenHash: sha256(token),
    label: label?.trim().slice(0, MAX_LABEL_LENGTH) || null,
  });
  const [user] = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.id, consumed.userId));
  return { token, user: { id: consumed.userId, name: user?.name ?? null } };
}

/**
 * The user a valid, unrevoked bearer token belongs to, or null. Touches
 * last_used_at (best-effort) so Settings can show which importers are alive.
 */
export async function getUserForImportToken(
  authorization: string | null
): Promise<SessionUser | null> {
  const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null;
  const [row] = await db
    .select({
      tokenId: extensionTokens.id,
      id: users.id,
      email: users.email,
      name: users.name,
    })
    .from(extensionTokens)
    .innerJoin(users, eq(users.id, extensionTokens.userId))
    .where(
      and(
        eq(extensionTokens.tokenHash, sha256(token)),
        isNull(extensionTokens.revokedAt)
      )
    );
  if (!row) return null;
  void db
    .update(extensionTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(extensionTokens.id, row.tokenId))
    .catch(() => undefined);
  return { id: row.id, email: row.email, name: row.name };
}

/** Active (unrevoked) importer connections for the Settings panel, newest first. */
export async function listExtensionTokens(
  userId: string
): Promise<ExtensionTokenDTO[]> {
  const rows = await db
    .select({
      id: extensionTokens.id,
      label: extensionTokens.label,
      createdAt: extensionTokens.createdAt,
      lastUsedAt: extensionTokens.lastUsedAt,
    })
    .from(extensionTokens)
    .where(
      and(eq(extensionTokens.userId, userId), isNull(extensionTokens.revokedAt))
    )
    .orderBy(desc(extensionTokens.createdAt));
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  }));
}

/** Revoke one of the user's importer tokens from Settings. False when absent. */
export async function revokeExtensionToken(
  userId: string,
  tokenId: string
): Promise<boolean> {
  const [revoked] = await db
    .update(extensionTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(extensionTokens.id, tokenId),
        eq(extensionTokens.userId, userId),
        isNull(extensionTokens.revokedAt)
      )
    )
    .returning({ id: extensionTokens.id });
  return Boolean(revoked);
}

/** Self-revoke by token value - the extension's "Disconnect" button. */
export async function revokeExtensionTokenByValue(
  authorization: string | null
): Promise<boolean> {
  const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return false;
  const [revoked] = await db
    .update(extensionTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(extensionTokens.tokenHash, sha256(token)),
        isNull(extensionTokens.revokedAt)
      )
    )
    .returning({ id: extensionTokens.id });
  return Boolean(revoked);
}
