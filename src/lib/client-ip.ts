// Best-effort client IP for rate limiting. matteob.dev is fronted by
// Cloudflare, which sets CF-Connecting-IP to the authoritative client address
// (a client cannot forge it past Cloudflare). Fall back to the first hop of
// X-Forwarded-For, then a constant so the limiter still applies globally even
// when no address is available (fail closed, not open).
export function getClientIp(headers: Headers): string {
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() || "unknown";
}
