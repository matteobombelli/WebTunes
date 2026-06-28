import { requirePageUser } from "@/lib/auth-helpers";
import { getUserSettings } from "@/lib/users";
import { MobileNav, MobileTopBar } from "@/components/MobileNav";
import PlayerBar from "@/components/PlayerBar";
import ServiceWorkerRegistrar from "@/components/ServiceWorkerRegistrar";
import SettingsModal from "@/components/SettingsModal";
import Sidebar from "@/components/Sidebar";
import Toast from "@/components/Toast";
import UploadProgressBar from "@/components/UploadProgressBar";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requirePageUser();
  const { normalizeVolume, similarVariation, similarDrift, hideFriendDuplicates } =
    await getUserSettings(user.id);

  return (
    <div className="flex h-dvh flex-col">
      <ServiceWorkerRegistrar />
      <UploadProgressBar />
      <MobileTopBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar userName={user.name} userEmail={user.email} />
        <main className="min-w-0 flex-1 overflow-y-auto p-4 md:p-6">
          {children}
        </main>
      </div>
      <PlayerBar
        initialNormalizeVolume={normalizeVolume}
        initialSimilarDrift={similarDrift}
        initialHideFriendDuplicates={hideFriendDuplicates}
      />
      <MobileNav />
      <Toast />
      <SettingsModal
        initialSimilarVariation={similarVariation}
        userEmail={user.email}
        userName={user.name}
      />
    </div>
  );
}
