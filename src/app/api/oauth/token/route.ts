import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/client-ip";
import { rateLimit } from "@/lib/rate-limit";
import { CORS_HEADERS, corsPreflight } from "@/lib/oauth/config";
import { exchangeAuthorizationCode, refreshAccessToken } from "@/lib/oauth/tokens";

const MINUTE_MS = 60 * 1000;
const HEADERS = { "Cache-Control": "no-store", ...CORS_HEADERS };

function oauthError(error: string, description: string, status = 400) {
  return NextResponse.json(
    { error, error_description: description },
    { status, headers: HEADERS }
  );
}

// RFC 6749 mandates form encoding; JSON is tolerated for lenient clients.
async function readParams(req: NextRequest): Promise<Record<string, unknown>> {
  if (req.headers.get("content-type")?.includes("application/json")) {
    const body = await req.json().catch(() => null);
    return body && typeof body === "object" ? body : {};
  }
  return Object.fromEntries(new URLSearchParams(await req.text()));
}

export async function POST(req: NextRequest) {
  if (!rateLimit(`oauth-token:${getClientIp(req.headers)}`, 60, MINUTE_MS)) {
    return oauthError("temporarily_unavailable", "Too many requests", 429);
  }
  const params = await readParams(req);
  const str = (key: string) =>
    typeof params[key] === "string" ? (params[key] as string) : undefined;

  const clientId = str("client_id");
  if (!clientId) return oauthError("invalid_client", "client_id is required", 401);
  const resource = str("resource");

  let result;
  switch (str("grant_type")) {
    case "authorization_code": {
      const code = str("code");
      const redirectUri = str("redirect_uri");
      const codeVerifier = str("code_verifier");
      if (!code || !redirectUri || !codeVerifier) {
        return oauthError("invalid_request", "code, redirect_uri and code_verifier are required");
      }
      result = await exchangeAuthorizationCode({ code, clientId, redirectUri, codeVerifier, resource });
      break;
    }
    case "refresh_token": {
      const refreshToken = str("refresh_token");
      if (!refreshToken) return oauthError("invalid_request", "refresh_token is required");
      result = await refreshAccessToken({ refreshToken, clientId, resource });
      break;
    }
    default:
      return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token");
  }

  if ("error" in result) return oauthError(result.error, result.error_description);
  return NextResponse.json(result, { headers: HEADERS });
}

export const OPTIONS = corsPreflight;
