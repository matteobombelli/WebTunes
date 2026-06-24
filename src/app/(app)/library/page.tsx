import { requirePageUser } from "@/lib/auth-helpers";
import { listOwnTracks } from "@/lib/tracks";
import { getUserSettings } from "@/lib/users";
import LibraryBrowser from "@/components/LibraryBrowser";
import UploadDialog from "@/components/UploadDialog";

export default async function LibraryPage() {
  const user = await requirePageUser();
  const [trackDTOs, settings] = await Promise.all([
    listOwnTracks(user.id),
    getUserSettings(user.id),
  ]);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-display text-2xl font-bold tracking-tight">Your Library</h1>
        <UploadDialog />
      </div>
      <LibraryBrowser
        initialTracks={trackDTOs}
        initialHideDuplicates={settings.hideFriendDuplicates}
        initialNormalizeVolume={settings.normalizeVolume}
      />
    </div>
  );
}
