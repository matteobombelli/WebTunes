import type {
  CallToolResult,
  McpServer,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { log } from "@/lib/log";
import type { McpAuth } from "@/lib/oauth/tokens";
import type { PlaylistDTO, TrackDTO } from "@/lib/types";
import { isUuid } from "@/lib/validate";

export const UNDO_NOTE =
  "Recorded in the undo log; reversible for 30 days with undo_action.";

export const uuid = z.string().refine(isUuid, "Expected a UUID");

/** Everything a tool needs about its caller, built once per request. */
export type ToolContext = {
  auth: McpAuth;
  base: string;
  track: (t: TrackDTO) => TrackOut;
  playlist: (p: PlaylistDTO) => PlaylistOut;
  playlistLink: (id: string) => string;
};

type TrackOut = {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  durationSec: number | null;
  owner: string;
  isPrivate: boolean;
  addedAt: string;
  link: string;
};

type PlaylistOut = {
  id: string;
  name: string;
  isPrivate: boolean;
  trackCount: number | null;
  owner: string;
  canEdit: boolean;
  updatedAt: string;
  link: string;
};

export function toolContext(auth: McpAuth, base: string): ToolContext {
  const owner = (ownerId: string, ownerName: string | null | undefined) =>
    ownerId === auth.userId ? "you" : (ownerName ?? "a friend");
  // There is no per-track page: link to the album, else the artist, else the library.
  const trackLink = (t: TrackDTO) =>
    t.album
      ? `${base}/album?name=${encodeURIComponent(t.album)}`
      : t.artist
        ? `${base}/artist?name=${encodeURIComponent(t.artist)}`
        : `${base}/library`;
  const playlistLink = (id: string) => `${base}/playlists/${id}`;
  return {
    auth,
    base,
    playlistLink,
    track: (t) => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      album: t.album,
      durationSec: t.durationSec,
      owner: owner(t.ownerId, t.ownerName),
      isPrivate: t.isPrivate,
      addedAt: t.createdAt,
      link: trackLink(t),
    }),
    playlist: (p) => ({
      id: p.id,
      name: p.name,
      isPrivate: p.isPrivate,
      trackCount: p.trackCount ?? null,
      owner: owner(p.ownerId, p.ownerName),
      canEdit: p.role === "owner" || p.role === "collaborator",
      updatedAt: p.updatedAt,
      link: playlistLink(p.id),
    }),
  };
}

export function ok(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

export function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Thrown inside a transaction to roll it back and surface `message` as a tool error. */
export class ToolError extends Error {}

export const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
export const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};

/**
 * registerTool with outcome/duration logging. Arguments and results carry user
 * content, so only the tool name, outcome and timing are ever logged.
 */
export function defineTool<S extends z.ZodObject>(
  server: McpServer,
  name: string,
  config: {
    title: string;
    description: string;
    inputSchema: S;
    annotations: ToolAnnotations;
  },
  handler: (args: z.output<S>) => Promise<CallToolResult>
): void {
  // The SDK validated `args` against inputSchema before calling this; the
  // cast only restores the type its generic signature loses for a generic S.
  server.registerTool<StandardSchemaWithJSON, StandardSchemaWithJSON>(name, config, async (args) => {
    const started = Date.now();
    try {
      const result = await handler(args as z.output<S>);
      log.info(
        "mcp",
        `${name} ${result.isError ? "tool_error" : "ok"} ${Date.now() - started}ms`
      );
      return result;
    } catch (err) {
      if (err instanceof ToolError) {
        log.info("mcp", `${name} tool_error ${Date.now() - started}ms`);
        return fail(err.message);
      }
      const code = (err as { code?: unknown })?.code;
      log.error(
        "mcp",
        `${name} failed ${Date.now() - started}ms`,
        typeof code === "string" ? code : err instanceof Error ? err.name : "unknown"
      );
      return fail("Something went wrong. Try again later.");
    }
  });
}
