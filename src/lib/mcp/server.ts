import { McpServer, type McpServerFactory } from "@modelcontextprotocol/server";
import { getAppBaseUrl } from "@/lib/app-url";
import type { Scope } from "@/lib/oauth/config";
import type { McpAuth } from "@/lib/oauth/tokens";
import { registerReadTools } from "./tools/read";
import { toolContext } from "./tools/shared";
import { registerWriteTools } from "./tools/write";

// The tool set depends only on the token's scopes, which re-consent can change.
const LIST_CACHE = { ttlMs: 60 * 1000, cacheScope: "private" } as const;

const INSTRUCTIONS =
  "WebTunes is the user's self-hosted music library, shared with their friends. " +
  "Results include web links the user can open. Every change made with these tools " +
  "is recorded and can be undone for 30 days with undo_action; tracks and playlists " +
  "cannot be deleted from here, only in the web app.";

const has = (auth: McpAuth, scope: Scope) => auth.scopes.includes(scope);

/** One server per request, exposing only the tools the caller's scopes allow. */
export function createMcpServer(auth: McpAuth): McpServer {
  const server = new McpServer(
    { name: "webtunes", title: "WebTunes", version: "1.0.0" },
    {
      instructions: INSTRUCTIONS,
      cacheHints: { "tools/list": LIST_CACHE, "server/discover": LIST_CACHE },
    }
  );
  const ctx = toolContext(auth, getAppBaseUrl());
  if (has(auth, "library:read")) registerReadTools(server, ctx);
  if (has(auth, "library:write")) registerWriteTools(server, ctx);
  return server;
}

/** The route passes the verified caller through `authInfo.extra.mcp`. */
export const mcpServerFactory: McpServerFactory = ({ authInfo }) => {
  const auth = authInfo?.extra?.mcp as McpAuth | undefined;
  if (!auth) throw new Error("MCP request reached the server without authentication");
  return createMcpServer(auth);
};
