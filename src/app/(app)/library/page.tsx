import { requirePageUser } from "@/lib/auth-helpers";
import { listOwnTracks } from "@/lib/tracks";
import LibraryBrowser from "@/components/LibraryBrowser";
import UploadButton from "@/components/UploadButton";
import DownloadImporterButton from "@/components/DownloadImporterButton";

export default async function LibraryPage() {
  const user = await requirePageUser();
  const trackDTOs = await listOwnTracks(user.id);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-display text-4xl font-bold tracking-tight">Your Library</h1>
        <div className="flex items-center gap-2">
          <DownloadImporterButton />
          <UploadButton />
        </div>
      </div>
      <LibraryBrowser initialTracks={trackDTOs} />
    </div>
  );
}
