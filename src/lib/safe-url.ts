import { isIP } from "net";

/**
 * SSRF guard for outbound fetches whose URL a client controls (import art
 * URLs, OAuth Client ID Metadata Documents): require a public-web-shaped https
 * URL - no IP literals, localhost, or internal-suffix hosts (blocks
 * loopback/LAN/cloud-metadata targets). Not DNS-rebinding-proof, so callers
 * must also disable redirects; together that closes the doors such a URL has
 * no business opening.
 */
export function isPublicHttpsUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  const bare =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIP(bare) !== 0) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local") || host.endsWith(".internal")) return false;
  return host.includes(".");
}
