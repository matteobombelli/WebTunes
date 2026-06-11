import { desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { tracks } from "@/db/schema";
import { auth } from "@/lib/auth";
import type { TrackDTO } from "@/lib/types";
import LibraryView from "@/components/LibraryView";
import UploadDialog from "@/components/UploadDialog";

export default async function LibraryPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const rows = await db
    .select()
    .from(tracks)
    .where(eq(tracks.ownerId, session.user.id))
    .orderBy(desc(tracks.createdAt));

  const trackDTOs: TrackDTO[] = rows.map((t) => ({
    ...t,
    createdAt: t.createdAt.toISOString(),
  }));

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
      <LibraryView tracks={trackDTOs} />
    </div>
  );
}
