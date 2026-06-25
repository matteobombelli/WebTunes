import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Validated against the DB (not just cookie presence, as the proxy can't do
  // at the edge): a real session bounces to the app, a stale cookie renders the
  // auth page instead of looping. See src/proxy.ts.
  const session = await auth();
  if (session?.user?.id) redirect("/library");

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-0 text-fg">
      <div className="w-full max-w-sm rounded-xl border border-border-subtle bg-surface-1 p-8 shadow-xl">
        <h1 className="mb-6 text-center font-display text-2xl font-bold tracking-tight">
          <span className="text-accent-bright">Web</span>Tunes
        </h1>
        {children}
      </div>
    </div>
  );
}
