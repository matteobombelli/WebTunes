import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { MobileNav, MobileTopBar } from "@/components/MobileNav";
import PlayerBar from "@/components/PlayerBar";
import Sidebar from "@/components/Sidebar";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  return (
    <div className="flex h-dvh flex-col">
      <MobileTopBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar
          userName={session.user.name ?? null}
          userEmail={session.user.email ?? ""}
        />
        <main className="min-w-0 flex-1 overflow-y-auto p-4 md:p-6">
          {children}
        </main>
      </div>
      <PlayerBar />
      <MobileNav />
    </div>
  );
}
