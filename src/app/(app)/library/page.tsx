import { requirePageUser } from "@/lib/auth-helpers";
import { listOwnTracks } from "@/lib/tracks";
import TrackList from "@/components/TrackList";
import UploadDialog from "@/components/UploadDialog";

export default async function LibraryPage() {
  const user = await requirePageUser();
  const trackDTOs = await listOwnTracks(user.id);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Your Library</h1>
          <p className="text-sm text-neutral-400">
            {trackDTOs.length} track{trackDTOs.length === 1 ? "" : "s"}
          </p>
        </div>
        <UploadDialog />
      </div>
      <TrackList tracks={trackDTOs} canDelete canEdit selectable sortable />
    </div>
  );
}
