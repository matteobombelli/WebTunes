import { requirePageUser } from "@/lib/auth-helpers";
import {
  listFriendsRecentlyPlayed,
  listNewTracks,
  listTopTracks,
  randomSeedTrack,
} from "@/lib/discover";
import { friendsOf, pendingRequestsFor } from "@/lib/friends";
import { findSimilarToCentroid } from "@/lib/similar";
import { getUserSettings } from "@/lib/users";
import DiscoverBrowser from "@/components/DiscoverBrowser";

export default async function DiscoverPage() {
  const user = await requirePageUser();
  const { hideFriendDuplicates } = await getUserSettings(user.id);

  // Top-100 resolves first: its ids both seed "Recommended" and are excluded
  // from it. The rest are independent, so they run together. friendIdsOf and
  // getUserSettings are cache()d, so the sections share one round-trip each.
  const top = await listTopTracks(user.id);
  const topIds = top.map((t) => t.id);

  const [recommended, random, friendsPlayed, newTracks, friends, requests] =
    await Promise.all([
      findSimilarToCentroid(user.id, topIds, { limit: 50, excludeIds: topIds }),
      randomSeedTrack(user.id, hideFriendDuplicates),
      listFriendsRecentlyPlayed(user.id, hideFriendDuplicates),
      listNewTracks(user.id, hideFriendDuplicates),
      friendsOf(user.id),
      pendingRequestsFor(user.id),
    ]);

  return (
    <div className="mx-auto max-w-5xl">
      <DiscoverBrowser
        sections={{ top, recommended, random, friendsPlayed, newTracks }}
        friends={friends}
        requests={requests}
      />
    </div>
  );
}
