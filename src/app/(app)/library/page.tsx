import { requirePageUser } from "@/lib/auth-helpers";
import { countOwnTracks, listOwnTracksPage } from "@/lib/tracks";
import ImportButton from "@/components/ImportButton";
import LibraryBrowser from "@/components/LibraryBrowser";
import UploadButton from "@/components/UploadButton";

// The server render (and every router.refresh after a mutation) ships only the
// newest slice of the library; LibraryBrowser keyset-paginates the older rows as
// the user scrolls. Keeps both the RSC and follow-up payloads bounded.
const INITIAL_TRACKS = 200;

export default async function LibraryPage() {
  const user = await requirePageUser();
  const [initialPage, totalTracks] = await Promise.all([
    listOwnTracksPage(user.id, INITIAL_TRACKS),
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
      <LibraryBrowser initialPage={initialPage} totalTracks={totalTracks} />
    </div>
  );
}
