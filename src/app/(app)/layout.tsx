import { requirePageUser } from "@/lib/auth-helpers";
import { pendingRequestsFor } from "@/lib/friends";
import { storageOrigin } from "@/lib/s3";
import { getUserSettings } from "@/lib/users";
import ConfirmDialog from "@/components/ConfirmDialog";
import ImportProgressBar from "@/components/ImportProgressBar";
import { MobileNav, MobileTopBar } from "@/components/MobileNav";
import PlayerBar from "@/components/PlayerBar";
import ServiceWorkerRegistrar from "@/components/ServiceWorkerRegistrar";
import SettingsModal from "@/components/SettingsModal";
import Sidebar from "@/components/Sidebar";
import Toast from "@/components/Toast";
import TutorialTour from "@/components/TutorialTour";
import UploadProgressBar from "@/components/UploadProgressBar";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requirePageUser();
  // pendingRequestsFor drives the incoming-request notification dot in the nav;
  // it's cache()d, so this shares the discover page's query within one request.
  const [
    {
      normalizeVolume,
      similarVariation,
      similarDrift,
      hideFriendDuplicates,
      tutorialSeen,
    },
    pendingRequests,
    artOrigin,
  ] = await Promise.all([
    getUserSettings(user.id),
    pendingRequestsFor(user.id),
    // Signing needs S3 credentials, which a build-time render may not have.
    storageOrigin().catch(() => null),
  ]);
  const hasIncomingRequests = pendingRequests.some(
    (r) => r.direction === "incoming"
  );

  return (
    <div className="flex h-dvh flex-col">
      {/* Saves DNS+TLS on the first art/audio request of the document. Two
          links because browsers pool connections by credentials mode: the SW's
          CORS art fetch uses the anonymous pool, <img>/<audio> the other. */}
      {artOrigin && (
        <>
          <link rel="preconnect" href={artOrigin} />
          <link rel="preconnect" href={artOrigin} crossOrigin="anonymous" />
        </>
      )}
      <ServiceWorkerRegistrar userId={user.id} />
      <UploadProgressBar />
      <ImportProgressBar />
      <MobileTopBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar
          userName={user.name}
          userEmail={user.email}
          hasIncomingRequests={hasIncomingRequests}
        />
        <main className="min-w-0 flex-1 overflow-y-auto p-4 md:p-6">
          {children}
        </main>
      </div>
      <PlayerBar
        initialNormalizeVolume={normalizeVolume}
        initialSimilarDrift={similarDrift}
        initialHideFriendDuplicates={hideFriendDuplicates}
      />
      <MobileNav hasIncomingRequests={hasIncomingRequests} />
      <Toast />
      <ConfirmDialog />
      <SettingsModal
        initialSimilarVariation={similarVariation}
        userEmail={user.email}
        userName={user.name}
      />
      <TutorialTour initialSeen={tutorialSeen} />
    </div>
  );
}
