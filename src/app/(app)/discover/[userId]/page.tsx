import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requirePageUser } from "@/lib/auth-helpers";
import { listUserTopTracks } from "@/lib/discover";
import { areFriends } from "@/lib/friends";
import { listFriendTracks } from "@/lib/tracks";
import { getUserSettings } from "@/lib/users";
import { isUuid } from "@/lib/validate";
import DiscoverSection from "@/components/DiscoverSection";
import TrackList from "@/components/TrackList";

export default async function FriendLibraryPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const user = await requirePageUser();

  const { userId } = await params;
  if (!isUuid(userId)) notFound();
  if (!(await areFriends(user.id, userId))) notFound();

  const [friend] = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  if (!friend) notFound();

  const displayName = friend.name ?? friend.email;
  const { hideFriendDuplicates } = await getUserSettings(user.id);
  const [topTracks, trackDTOs] = await Promise.all([
    listUserTopTracks(userId, user.id, hideFriendDuplicates),
    listFriendTracks(userId, displayName),
  ]);

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-6 font-display text-4xl font-bold tracking-tight">
        {displayName}
      </h1>

      <DiscoverSection
        title={`${displayName}'s Top 100`}
        tracks={topTracks}
        emptyHint="No plays yet."
      />

      <div className="mt-8">
        <h2 className="font-display text-lg font-semibold sm:text-[1.6875rem]">
          {displayName}&apos;s Library
        </h2>
        <p className="mb-3 text-sm text-fg-muted">
          {trackDTOs.length} track{trackDTOs.length === 1 ? "" : "s"} shared with you
        </p>
        <TrackList tracks={trackDTOs} />
      </div>
    </div>
  );
}
