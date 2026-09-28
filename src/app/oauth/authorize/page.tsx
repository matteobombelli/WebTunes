import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth-helpers";
import { isDemoAccount } from "@/lib/demo-accounts";
import { checkAuthorizeRequest, pickAuthorizeParams } from "@/lib/oauth/authorize";
import { ConsentForm } from "./ConsentForm";

// OAuth consent page. Outside the (app) and (auth) groups: it needs a session
// but must not get the app chrome, and (auth) would bounce signed-in users.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Connect an app · WebTunes" };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-0 p-4 text-fg">
      <div className="w-full max-w-sm rounded-xl border border-border-subtle bg-surface-1 p-8 shadow-xl">
        <h1 className="mb-6 text-center font-display text-2xl font-bold tracking-tight">
          <span className="text-accent-bright">Web</span>Tunes
        </h1>
        {children}
      </div>
    </div>
  );
}

export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const params = pickAuthorizeParams((name) => raw[name]);

  // Sign-in comes first so resolving a client (a CIMD fetch) is never unauthenticated.
  const user = await requireUser();
  if (!user) {
    const query = new URLSearchParams(params as Record<string, string>);
    redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${query}`)}`);
  }

  const check = await checkAuthorizeRequest(params);
  if (check.kind === "error_page") {
    return (
      <Card>
        <h2 className="mb-2 font-display text-lg font-semibold">Can’t connect this app</h2>
        <p className="text-sm text-fg-muted">{check.message}</p>
        {check.error && (
          <p className="mt-2 text-xs text-fg-muted">
            Error: <code>{check.error}</code>
          </p>
        )}
      </Card>
    );
  }

  const redirectHost = new URL(check.redirectUri).host;
  const isLoopback = LOOPBACK_HOSTS.has(new URL(check.redirectUri).hostname);
  const cimdHost =
    check.client.kind === "cimd" ? new URL(check.client.id).host : null;

  return (
    <Card>
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold">
            {check.client.name} wants to access your WebTunes account
          </h2>
          <p className="mt-1 text-sm text-fg-muted">
            Signed in as <span className="text-fg">{user.name ?? user.email}</span>
          </p>
        </div>
        <div className="flex flex-col gap-1 rounded-md border border-border-subtle bg-surface-2 p-3 text-sm">
          <p>
            <span className="text-fg-muted">Sends you back to: </span>
            <span className="break-all font-medium">{redirectHost}</span>
          </p>
          {isLoopback && (
            <p className="text-fg-muted">This app runs on this computer.</p>
          )}
          {cimdHost && (
            <p>
              <span className="text-fg-muted">App published by: </span>
              <span className="break-all font-medium">{cimdHost}</span>
            </p>
          )}
        </div>
        <p className="text-sm text-fg-muted">Only allow apps you trust.</p>
        <ConsentForm
          params={params as Record<string, string>}
          writeRequested={check.scopes.includes("library:write")}
          demo={isDemoAccount(user.email)}
        />
      </div>
    </Card>
  );
}
