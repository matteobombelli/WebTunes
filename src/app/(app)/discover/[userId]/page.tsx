import { notFound } from "next/navigation";
import { requirePageUser } from "@/lib/auth-helpers";
import { listUserTopTracks } from "@/lib/discover";
import { areFriends } from "@/lib/friends";
import { listTracksOfFriend } from "@/lib/tracks";
import { getDisplayName, getUserSettings } from "@/lib/users";
import { isUuid } from "@/lib/validate";
import DiscoverSection, { sectionHeadingClass } from "@/components/DiscoverSection";
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

  const displayName = await getDisplayName(userId);
  if (!displayName) notFound();
  const { hideFriendDuplicates } = await getUserSettings(user.id);
  const [topTracks, trackDTOs] = await Promise.all([
    listUserTopTracks(userId, user.id, hideFriendDuplicates),
    listTracksOfFriend(userId, displayName),
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
        <h2 className={sectionHeadingClass}>{displayName}&apos;s Library</h2>
        <p className="mb-3 text-sm text-fg-muted">
          {trackDTOs.length} track{trackDTOs.length === 1 ? "" : "s"} shared with you
        </p>
        <TrackList tracks={trackDTOs} sortable />
      </div>
    </div>
  );
}
