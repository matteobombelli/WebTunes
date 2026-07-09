import { requirePageUser } from "@/lib/auth-helpers";
import { countOwnTracks, listOwnTracks } from "@/lib/tracks";
import ImportButton from "@/components/ImportButton";
import LibraryBrowser from "@/components/LibraryBrowser";
import UploadButton from "@/components/UploadButton";

// The server render (and every router.refresh after a mutation) ships only the
// newest slice of the library; LibraryBrowser background-fetches the full list
// once per snapshot. Keeps the RSC payload small at 1000+-track library sizes.
const INITIAL_TRACKS = 200;

export default async function LibraryPage() {
  const user = await requirePageUser();
  const [trackDTOs, totalTracks] = await Promise.all([
    listOwnTracks(user.id, INITIAL_TRACKS),
    countOwnTracks(user.id),
  ]);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-display text-4xl font-bold tracking-tight">Your Library</h1>
        <div className="flex items-center gap-2" data-tour="add-music">
          <ImportButton />
          <UploadButton />
        </div>
      </div>
      <LibraryBrowser initialTracks={trackDTOs} totalTracks={totalTracks} />
    </div>
  );
}
