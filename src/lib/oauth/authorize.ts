import { db } from "@/db";
import { oauthCodes, oauthGrants } from "@/db/schema";
import { CODE_TTL_SEC, issuer, mcpResource, parseScopes, type Scope } from "./config";
import { resolveClient, type OAuthClient } from "./clients";
import { randomToken, sha256Hex } from "./crypto";

export const AUTHORIZE_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "state",
  "resource",
] as const;

export type AuthorizeParams = Partial<
  Record<(typeof AUTHORIZE_PARAMS)[number], string>
>;

export type AuthorizeCheck =
  | { kind: "error_page"; message: string; error?: string }
  | {
      kind: "ok";
      client: OAuthClient;
      redirectUri: string;
      codeChallenge: string;
      state: string | undefined;
      scopes: Scope[];
    };

/** Picks the known parameters; repeated parameters are treated as absent (RFC 6749 §3.1). */
export function pickAuthorizeParams(
  get: (name: string) => string | string[] | null | undefined
): AuthorizeParams {
  const params: AuthorizeParams = {};
  for (const name of AUTHORIZE_PARAMS) {
    const value = get(name);
    if (typeof value === "string") params[name] = value;
  }
  return params;
}

/** redirect_uri plus response parameters and `iss` (RFC 9207). */
export function authorizationResponseUrl(
  redirectUri: string,
  params: Record<string, string | undefined>
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  url.searchParams.set("iss", issuer());
  return url.toString();
}

/**
 * Validates an authorization request. Every error is shown on our own page,
 * never sent to redirect_uri: redirecting without user interaction would make
 * this an open redirector for any registered client.
 */
export async function checkAuthorizeRequest(
  p: AuthorizeParams
): Promise<AuthorizeCheck> {
  const client = p.client_id ? await resolveClient(p.client_id) : null;
  if (!client) {
    return { kind: "error_page", message: "This app is not registered, or its registration could not be loaded." };
  }
  if (!p.redirect_uri || !client.redirectUris.includes(p.redirect_uri)) {
    return { kind: "error_page", message: "The app sent a redirect address it did not register." };
  }
  const fail = (error: string, description: string): AuthorizeCheck => ({
    kind: "error_page",
    message: description,
    error,
  });
  if (p.response_type !== "code") {
    return fail("unsupported_response_type", "response_type must be code");
  }
  if (!p.code_challenge || p.code_challenge_method !== "S256") {
    return fail("invalid_request", "PKCE with code_challenge_method S256 is required");
  }
  if (p.resource !== undefined && p.resource !== mcpResource()) {
    return fail("invalid_target", "Unknown resource");
  }
  return {
    kind: "ok",
    client,
    redirectUri: p.redirect_uri,
    codeChallenge: p.code_challenge,
    state: p.state,
    scopes: parseScopes(p.scope),
  };
}

/** Records consent for (user, client) and returns a single-use authorization code. */
export async function issueAuthorizationCode(input: {
  userId: string;
  clientId: string;
  scopes: Scope[];
  redirectUri: string;
  codeChallenge: string;
}): Promise<string> {
  const code = randomToken();
  await db.transaction(async (tx) => {
    const resource = mcpResource();
    const [grant] = await tx
      .insert(oauthGrants)
      .values({
        userId: input.userId,
        clientId: input.clientId,
        scopes: input.scopes,
        resource,
      })
      .onConflictDoUpdate({
        target: [oauthGrants.userId, oauthGrants.clientId],
        set: { scopes: input.scopes, resource },
      })
      .returning({ id: oauthGrants.id });
    await tx.insert(oauthCodes).values({
      codeHash: sha256Hex(code),
      grantId: grant.id,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      expiresAt: new Date(Date.now() + CODE_TTL_SEC * 1000),
    });
  });
  return code;
}
