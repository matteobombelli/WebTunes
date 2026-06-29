import { requirePageUser } from "@/lib/auth-helpers";
import {
  listFriendsTop,
  listNewTracks,
  listTopTracks,
  randomSeedTracks,
} from "@/lib/discover";
import { friendsOf, pendingRequestsFor } from "@/lib/friends";
import { INVITE_BLOCKED_EMAILS } from "@/lib/invites";
import { findRecommendedClusters } from "@/lib/similar";
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

  const [recommended, random, friendsTop, newTracks, friends, requests] =
    await Promise.all([
      findRecommendedClusters(user.id, topIds, { limit: 100, excludeIds: topIds }),
      randomSeedTracks(user.id, hideFriendDuplicates),
      listFriendsTop(user.id, hideFriendDuplicates),
      listNewTracks(user.id, hideFriendDuplicates),
      friendsOf(user.id),
      pendingRequestsFor(user.id),
    ]);

  return (
    <div className="mx-auto max-w-5xl">
      <DiscoverBrowser
        sections={{ top, recommended, random, friendsTop, newTracks }}
        friends={friends}
        requests={requests}
        canInvite={!INVITE_BLOCKED_EMAILS.has(user.email)}
      />
    </div>
  );
}
