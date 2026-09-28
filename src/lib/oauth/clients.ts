import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { oauthClients } from "@/db/schema";
import { isPublicHttpsUrl } from "@/lib/safe-url";
import { log } from "@/lib/log";
import { rateLimit } from "@/lib/rate-limit";
import { randomToken } from "./crypto";

export type OAuthClient = typeof oauthClients.$inferSelect;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_NAME = 100;
const CIMD_TIMEOUT_MS = 5000;
const CIMD_MAX_BYTES = 64 * 1024;
const CIMD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CIMD_FAILURE_TTL_MS = 5 * 60 * 1000;
const CIMD_HOST_LIMIT = 10;
const CIMD_HOST_WINDOW_MS = 10 * 60 * 1000;

/** client_id -> time until which a failed CIMD fetch is not retried. */
const cimdFailures = new Map<string, number>();

/** https anywhere, or http on a loopback host with any port (RFC 8252 native apps). */
export function isValidRedirectUri(raw: string): boolean {
  if (raw.length > 2000 || raw.includes("#")) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

function isValidClientUri(raw: string): boolean {
  try {
    return new URL(raw).protocol === "https:";
  } catch {
    return false;
  }
}

const redirectUrisSchema = z
  .array(z.string())
  .min(1)
  .max(10)
  .refine((uris) => uris.every(isValidRedirectUri));

const dcrSchema = z.object({
  redirect_uris: z.unknown(),
  client_name: z.string().trim().max(MAX_NAME).optional(),
  client_uri: z.string().refine(isValidClientUri).optional(),
});

type RegistrationError = {
  error: "invalid_redirect_uri" | "invalid_client_metadata";
  error_description: string;
};

/** RFC 7591 dynamic registration. Always a public client, whatever auth method was asked for. */
export async function registerClient(
  body: unknown
): Promise<{ client: OAuthClient } | RegistrationError> {
  const parsed = dcrSchema.safeParse(body);
  if (!parsed.success) {
    return {
      error: "invalid_client_metadata",
      error_description: "client_name must be at most 100 characters; client_uri must be https",
    };
  }
  const redirectUris = redirectUrisSchema.safeParse(parsed.data.redirect_uris);
  if (!redirectUris.success) {
    return {
      error: "invalid_redirect_uri",
      error_description:
        "Provide 1-10 redirect_uris, each https or http loopback, without a fragment",
    };
  }
  const [client] = await db
    .insert(oauthClients)
    .values({
      id: `dcr_${randomToken()}`,
      kind: "dcr",
      name: parsed.data.client_name || "Unnamed app",
      redirectUris: redirectUris.data,
      clientUri: parsed.data.client_uri ?? null,
    })
    .returning();
  return { client };
}

/** A Client ID Metadata Document id: an https URL with a path, no fragment or userinfo. */
export function isCimdClientId(clientId: string): boolean {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.pathname.length > 1 &&
    !clientId.includes("#") &&
    !url.username &&
    !url.password
  );
}

const cimdSchema = z.object({
  client_id: z.string(),
  client_name: z.string().trim().min(1),
  redirect_uris: redirectUrisSchema,
  client_uri: z.string().refine(isValidClientUri).optional(),
});

async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// The client_id URL is attacker-chosen, so the fetch gets the same SSRF rules
// as art imports: public https only, no redirects, bounded time and size.
async function fetchCimd(clientId: string) {
  if (!isPublicHttpsUrl(clientId)) return null;
  try {
    const res = await fetch(clientId, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(CIMD_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const text = await readCapped(res, CIMD_MAX_BYTES);
    if (text === null) return null;
    const parsed = cimdSchema.safeParse(JSON.parse(text));
    if (!parsed.success || parsed.data.client_id !== clientId) return null;
    return parsed.data;
  } catch (err) {
    log.warn("oauth", "client metadata fetch failed", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * The registered client for `clientId`: a DCR row, or a CIMD document
 * fetched and cached for 24 h (a failed refetch keeps serving the cached copy).
 * Failed fetches are not retried for 5 minutes, and fetches are rate-limited
 * per host.
 */
export async function resolveClient(clientId: string): Promise<OAuthClient | null> {
  if (!clientId || clientId.length > 2000) return null;
  const [cached] = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.id, clientId));

  if (!isCimdClientId(clientId)) return cached?.kind === "dcr" ? cached : null;

  const fresh =
    cached?.metadataFetchedAt &&
    Date.now() - cached.metadataFetchedAt.getTime() < CIMD_MAX_AGE_MS;
  if (fresh) return cached;

  const now = Date.now();
  if ((cimdFailures.get(clientId) ?? 0) > now) return cached ?? null;
  if (!rateLimit(`cimd-host:${new URL(clientId).host}`, CIMD_HOST_LIMIT, CIMD_HOST_WINDOW_MS)) {
    return cached ?? null;
  }
  const doc = await fetchCimd(clientId);
  if (!doc) {
    if (cimdFailures.size > 10_000) {
      for (const [id, until] of cimdFailures) if (until <= now) cimdFailures.delete(id);
    }
    cimdFailures.set(clientId, now + CIMD_FAILURE_TTL_MS);
    return cached ?? null;
  }
  cimdFailures.delete(clientId);
  const values = {
    name: doc.client_name.slice(0, MAX_NAME),
    redirectUris: doc.redirect_uris,
    clientUri: doc.client_uri ?? null,
    metadataFetchedAt: new Date(),
  };
  const [row] = await db
    .insert(oauthClients)
    .values({ id: clientId, kind: "cimd", ...values })
    .onConflictDoUpdate({ target: oauthClients.id, set: values })
    .returning();
  return row;
}
