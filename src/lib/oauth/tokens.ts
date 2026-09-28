import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  oauthClients,
  oauthCodes,
  oauthGrants,
  oauthTokens,
  users,
} from "@/db/schema";
import { ACCESS_TTL_SEC, REFRESH_TTL_SEC, mcpResource } from "./config";
import { pkceMatches, randomToken, sha256Hex } from "./crypto";

export type McpAuth = {
  userId: string;
  email: string;
  grantId: string;
  clientName: string;
  scopes: string[];
};

export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
};

export type TokenError = {
  error: "invalid_request" | "invalid_grant" | "invalid_target";
  error_description: string;
};

const LAST_USED_GRANULARITY_MS = 5 * 60 * 1000;
// RFC 7636 §4.1: 43-128 unreserved characters.
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

const invalidGrant = (description: string): TokenError => ({
  error: "invalid_grant",
  error_description: description,
});

async function issueTokenPair(grant: {
  id: string;
  scopes: string[];
}): Promise<TokenResponse> {
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const now = Date.now();
  await db.transaction(async (tx) => {
    await tx.insert(oauthTokens).values([
      {
        tokenHash: sha256Hex(accessToken),
        grantId: grant.id,
        kind: "access",
        expiresAt: new Date(now + ACCESS_TTL_SEC * 1000),
      },
      {
        tokenHash: sha256Hex(refreshToken),
        grantId: grant.id,
        kind: "refresh",
        expiresAt: new Date(now + REFRESH_TTL_SEC * 1000),
      },
    ]);
    await tx
      .update(oauthGrants)
      .set({ lastUsedAt: new Date(now) })
      .where(eq(oauthGrants.id, grant.id));
  });
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SEC,
    refresh_token: refreshToken,
    scope: grant.scopes.join(" "),
  };
}

async function loadGrant(id: string) {
  const [grant] = await db
    .select()
    .from(oauthGrants)
    .where(eq(oauthGrants.id, id));
  return grant ?? null;
}

export async function exchangeAuthorizationCode(p: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  resource?: string;
}): Promise<TokenResponse | TokenError> {
  const codeHash = sha256Hex(p.code);
  const now = new Date();
  const invalidCode = invalidGrant(
    "The authorization code is invalid, expired or already used"
  );
  const [code] = await db
    .select()
    .from(oauthCodes)
    .where(eq(oauthCodes.codeHash, codeHash));
  if (!code) return invalidCode;
  const grant = await loadGrant(code.grantId);
  const clientMatches = grant !== null && grant.clientId === p.clientId;
  const pkceValid =
    VERIFIER_RE.test(p.codeVerifier) && pkceMatches(p.codeVerifier, code.codeChallenge);

  // RFC 6749 §4.1.2: a replayed code revokes the tokens issued from it. Only a
  // presenter holding the original PKCE secret may trigger that, so a leaked
  // code alone cannot kill a grant.
  if (code.usedAt) {
    if (clientMatches && pkceValid) {
      await db.delete(oauthTokens).where(eq(oauthTokens.grantId, code.grantId));
    }
    return invalidCode;
  }
  if (code.expiresAt.getTime() <= now.getTime()) return invalidCode;

  // Validation happens before the claim, so a malformed request leaves the code usable.
  if (!clientMatches) {
    return invalidGrant("The authorization code was issued to another client");
  }
  if (p.redirectUri !== code.redirectUri) {
    return invalidGrant("redirect_uri does not match the authorization request");
  }
  if (!pkceValid) return invalidGrant("PKCE verification failed");
  if (p.resource !== undefined && p.resource !== grant.resource) {
    return { error: "invalid_target", error_description: "Unknown resource" };
  }

  // The conditional UPDATE is the atomic claim: two concurrent redemptions of
  // one code cannot both match `used_at IS NULL`.
  const [claimed] = await db
    .update(oauthCodes)
    .set({ usedAt: now })
    .where(
      and(
        eq(oauthCodes.codeHash, codeHash),
        isNull(oauthCodes.usedAt),
        gt(oauthCodes.expiresAt, now)
      )
    )
    .returning({ codeHash: oauthCodes.codeHash });
  if (!claimed) return invalidCode;
  return issueTokenPair(grant);
}

export async function refreshAccessToken(p: {
  refreshToken: string;
  clientId: string;
  resource?: string;
}): Promise<TokenResponse | TokenError> {
  const tokenHash = sha256Hex(p.refreshToken);
  const now = new Date();
  const [token] = await db
    .update(oauthTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(oauthTokens.tokenHash, tokenHash),
        eq(oauthTokens.kind, "refresh"),
        isNull(oauthTokens.usedAt),
        gt(oauthTokens.expiresAt, now)
      )
    )
    .returning();
  if (!token) {
    const [spent] = await db
      .select({ grantId: oauthTokens.grantId, usedAt: oauthTokens.usedAt })
      .from(oauthTokens)
      .where(
        and(eq(oauthTokens.tokenHash, tokenHash), eq(oauthTokens.kind, "refresh"))
      );
    // Rotated refresh tokens are single-use: a second presentation means one
    // copy leaked, so the whole grant is revoked (OAuth 2.1 §4.3.1).
    if (spent?.usedAt) {
      await db.delete(oauthGrants).where(eq(oauthGrants.id, spent.grantId));
    }
    return invalidGrant("The refresh token is invalid, expired or already used");
  }

  const grant = await loadGrant(token.grantId);
  if (!grant || grant.clientId !== p.clientId) {
    return invalidGrant("The refresh token was issued to another client");
  }
  if (p.resource !== undefined && p.resource !== grant.resource) {
    return { error: "invalid_target", error_description: "Unknown resource" };
  }
  return issueTokenPair(grant);
}

/**
 * Resolves an `Authorization: Bearer` header to the MCP caller, or null.
 * The token is a bearer secret: it is only ever hashed, never logged.
 */
export async function verifyAccessToken(
  authorizationHeader: string | null
): Promise<McpAuth | null> {
  const match = authorizationHeader?.match(/^Bearer +([A-Za-z0-9_-]{1,200})$/i);
  if (!match) return null;
  const now = new Date();
  const [row] = await db
    .select({
      userId: users.id,
      email: users.email,
      grantId: oauthGrants.id,
      clientName: oauthClients.name,
      scopes: oauthGrants.scopes,
      resource: oauthGrants.resource,
      lastUsedAt: oauthGrants.lastUsedAt,
    })
    .from(oauthTokens)
    .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
    .innerJoin(users, eq(users.id, oauthGrants.userId))
    .where(
      and(
        eq(oauthTokens.tokenHash, sha256Hex(match[1])),
        eq(oauthTokens.kind, "access"),
        gt(oauthTokens.expiresAt, now)
      )
    );
  if (!row || row.resource !== mcpResource()) return null;

  if (
    !row.lastUsedAt ||
    now.getTime() - row.lastUsedAt.getTime() > LAST_USED_GRANULARITY_MS
  ) {
    await db
      .update(oauthGrants)
      .set({ lastUsedAt: now })
      .where(eq(oauthGrants.id, row.grantId));
  }
  return {
    userId: row.userId,
    email: row.email,
    grantId: row.grantId,
    clientName: row.clientName,
    scopes: row.scopes,
  };
}
