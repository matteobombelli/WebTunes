import { requirePageUser } from "@/lib/auth-helpers";
import { listOwnTracks } from "@/lib/tracks";
import LibraryBrowser from "@/components/LibraryBrowser";
import UploadDialog from "@/components/UploadDialog";

export default async function LibraryPage() {
  const user = await requirePageUser();
  const trackDTOs = await listOwnTracks(user.id);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-display text-4xl font-bold tracking-tight">Your Library</h1>
        <UploadDialog />
      </div>
      <LibraryBrowser initialTracks={trackDTOs} />
    </div>
  );
}
