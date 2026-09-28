import { NextResponse } from "next/server";
import { getAppBaseUrl } from "@/lib/app-url";

export const SCOPES = ["library:read", "library:write"] as const;
export type Scope = (typeof SCOPES)[number];

export const ACCESS_TTL_SEC = 60 * 60;
export const REFRESH_TTL_SEC = 30 * 24 * 60 * 60;
export const CODE_TTL_SEC = 60;

// Functions rather than constants: AUTH_URL is only required at runtime, and
// module-level evaluation would throw during `next build` without it.
export function issuer(): string {
  return getAppBaseUrl();
}

export function mcpResource(): string {
  return `${issuer()}/api/mcp`;
}

export function protectedResourceMetadataUrl(): string {
  return `${issuer()}/.well-known/oauth-protected-resource`;
}

/** Space-separated scope string to known scopes; unknown ones are ignored, none means all. */
export function parseScopes(raw: string | null | undefined): Scope[] {
  const requested = new Set((raw ?? "").split(" ").filter(Boolean));
  const known = SCOPES.filter((s) => requested.has(s));
  return known.length > 0 ? known : [...SCOPES];
}

// Public clients (browser-based ones such as MCP Inspector) call discovery,
// registration and token endpoints cross-origin. None of them use cookies, so
// a wildcard origin exposes nothing.
export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
};

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function discoveryJson(body: object): Response {
  return NextResponse.json(body, {
    headers: { "Cache-Control": "public, max-age=3600", ...CORS_HEADERS },
  });
}

export function protectedResourceMetadataResponse(): Response {
  return discoveryJson({
    resource: mcpResource(),
    authorization_servers: [issuer()],
    scopes_supported: SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "WebTunes",
  });
}

// Served at both the RFC 8414 and OIDC discovery paths: Caddy owns root-level
// /.well-known, so clients reach it through the OIDC path-append fallback.
export function authorizationServerMetadataResponse(): Response {
  const iss = issuer();
  return discoveryJson({
    issuer: iss,
    authorization_endpoint: `${iss}/oauth/authorize`,
    token_endpoint: `${iss}/api/oauth/token`,
    registration_endpoint: `${iss}/api/oauth/register`,
    scopes_supported: SCOPES,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    // OIDC-required fields. No ID tokens are issued (the JWKS is empty); they
    // exist only so clients' OIDC discovery schema validation passes.
    jwks_uri: `${iss}/.well-known/jwks.json`,
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
  });
}

export function jwksResponse(): Response {
  return discoveryJson({ keys: [] });
}

/**
 * 401 for the MCP endpoint. `invalidToken` marks a presented-but-rejected
 * token (RFC 6750); without it the client is told how to start OAuth.
 */
export function mcpUnauthorizedResponse(invalidToken = false): Response {
  const params = [
    ...(invalidToken ? [`error="invalid_token"`] : []),
    `resource_metadata="${protectedResourceMetadataUrl()}"`,
    `scope="${SCOPES.join(" ")}"`,
  ];
  return NextResponse.json(
    { error: invalidToken ? "invalid_token" : "unauthorized" },
    {
      status: 401,
      headers: { "WWW-Authenticate": `Bearer ${params.join(", ")}` },
    }
  );
}
