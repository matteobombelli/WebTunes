import { createMcpHandler } from "@modelcontextprotocol/server";
import { log } from "@/lib/log";
import { mcpServerFactory } from "@/lib/mcp/server";
import { CORS_HEADERS, mcpUnauthorizedResponse } from "@/lib/oauth/config";
import { verifyAccessToken } from "@/lib/oauth/tokens";
import { rateLimit } from "@/lib/rate-limit";

const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;

const MCP_CORS_HEADERS = {
  ...CORS_HEADERS,
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
};

// Stateless: 2026-07-28 clients are served per request, and 2025-era clients
// through the SDK's stateless legacy fallback (GET/DELETE there answer 405).
const handler = createMcpHandler(mcpServerFactory, {
  legacy: "stateless",
  // Errors can quote request bodies, so only the error class is logged.
  onerror: (err) => log.warn("mcp", "request rejected", err.name),
});

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [name, value] of Object.entries(MCP_CORS_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return Response.json(
    { jsonrpc: "2.0", id: null, error: { code, message } },
    {
      status,
      headers: status === 429 ? { "Retry-After": String(RATE_WINDOW_MS / 1000) } : {},
    }
  );
}

async function serve(req: Request): Promise<Response> {
  const header = req.headers.get("authorization");
  let auth;
  try {
    auth = await verifyAccessToken(header);
  } catch (err) {
    log.error("mcp", "token verification failed", err instanceof Error ? err.name : "unknown");
    return jsonRpcError(500, -32603, "Internal error");
  }
  if (!auth) return mcpUnauthorizedResponse(header !== null);

  if (!rateLimit(`mcp:${auth.userId}`, RATE_LIMIT, RATE_WINDOW_MS)) {
    return jsonRpcError(
      429,
      -32000,
      `Rate limit exceeded: at most ${RATE_LIMIT} requests per minute`
    );
  }

  return handler.fetch(req, {
    // The factory needs only the resolved caller; the bearer secret stays here.
    authInfo: { token: "", clientId: auth.grantId, scopes: auth.scopes, extra: { mcp: auth } },
  });
}

async function mcp(req: Request): Promise<Response> {
  return withCors(await serve(req));
}

export const GET = mcp;
export const POST = mcp;
export const DELETE = mcp;

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: MCP_CORS_HEADERS });
}
