import { BASE_PATH } from "@/lib/base-path";

// Absolute base URL of the app (origin + basePath), used to build links in
// security-sensitive emails (password reset, email verification).
//
// AUTH_URL is the single source of truth. In production it is REQUIRED: we
// never derive the host from the incoming request, because a poisoned Host
// header could otherwise mint links that point at an attacker's domain. In
// dev we fall back to the request's (forwarded) host, then localhost.
export function getAppBaseUrl(headers?: Headers): string {
  const authUrl = process.env.AUTH_URL;
  if (authUrl) {
    // AUTH_URL is typically just the origin (Auth.js gets its path from the
    // separate basePath in lib/auth.ts), so append BASE_PATH ourselves. Stay
    // idempotent if AUTH_URL ever already carries the basePath and/or /api/auth.
    const base = authUrl.replace(/\/api\/auth\/?$/, "").replace(/\/$/, "");
    return base.endsWith(BASE_PATH) ? base : `${base}${BASE_PATH}`;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_URL must be set in production");
  }

  const host = headers?.get("x-forwarded-host") ?? headers?.get("host");
  const proto = headers?.get("x-forwarded-proto") ?? "http";
  const origin = host ? `${proto}://${host}` : "http://localhost:3000";
  return `${origin}${BASE_PATH}`;
}
