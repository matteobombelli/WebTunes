import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/client-ip";
import { rateLimit } from "@/lib/rate-limit";
import { registerClient } from "@/lib/oauth/clients";
import { CORS_HEADERS, corsPreflight } from "@/lib/oauth/config";

const HOUR_MS = 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  const headers = { "Cache-Control": "no-store", ...CORS_HEADERS };
  if (!rateLimit(`oauth-register:${getClientIp(req.headers)}`, 20, HOUR_MS)) {
    return NextResponse.json(
      { error: "invalid_client_metadata", error_description: "Too many registrations; try again later" },
      { status: 429, headers }
    );
  }
  const result = await registerClient(await req.json().catch(() => null));
  if ("error" in result) {
    return NextResponse.json(result, { status: 400, headers });
  }
  const { client } = result;
  return NextResponse.json(
    {
      client_id: client.id,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      ...(client.clientUri ? { client_uri: client.clientUri } : {}),
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    { status: 201, headers }
  );
}

export const OPTIONS = corsPreflight;
