import { requirePageUser } from "@/lib/auth-helpers";
import { isDemoAccount } from "@/lib/demo-accounts";
import { listOwnTracksPage } from "@/lib/tracks";
import ImportButton from "@/components/ImportButton";
import LibraryBrowser from "@/components/LibraryBrowser";
import UploadButton from "@/components/UploadButton";

// The server render (and every router.refresh after a mutation) ships only the
// newest slice of the library; LibraryBrowser keyset-paginates the older rows as
// the user scrolls. Keeps both the RSC and follow-up payloads bounded.
const INITIAL_TRACKS = 200;

export default async function LibraryPage() {
  const user = await requirePageUser();
  const initialPage = await listOwnTracksPage(user.id, INITIAL_TRACKS);
  const readOnly = isDemoAccount(user.email);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-display text-4xl font-bold tracking-tight">Your Library</h1>
        <div className="flex items-center gap-2" data-tour="add-music">
          <ImportButton readOnly={readOnly} />
          <UploadButton readOnly={readOnly} />
        </div>
      </div>
      <LibraryBrowser initialPage={initialPage} />
    </div>
  );
}
