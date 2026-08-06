// Demo credentials are public, so resource-heavy and destructive operations
// must be denied server-side rather than relying only on hidden client controls.
export const DEMO_ACCOUNT_EMAILS = new Set([
  "demo1@demo.demo",
  "demo2@demo.demo",
]);

export const DEMO_READ_ONLY_MESSAGE = "Demo accounts are read-only.";

export function isDemoAccount(email: string): boolean {
  return DEMO_ACCOUNT_EMAILS.has(email.trim().toLowerCase());
}
