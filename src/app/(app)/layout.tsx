import { requirePageUser } from "@/lib/auth-helpers";
import { MobileNav, MobileTopBar } from "@/components/MobileNav";
import PlayerBar from "@/components/PlayerBar";
import ServiceWorkerRegistrar from "@/components/ServiceWorkerRegistrar";
import Sidebar from "@/components/Sidebar";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requirePageUser();

  return (
    <div className="flex h-dvh flex-col">
      <ServiceWorkerRegistrar />
      <MobileTopBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar userName={user.name} userEmail={user.email} />
        <main className="min-w-0 flex-1 overflow-y-auto p-4 md:p-6">
          {children}
        </main>
      </div>
      <PlayerBar />
      <MobileNav />
    </div>
  );
}
