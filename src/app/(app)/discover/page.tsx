import { requirePageUser } from "@/lib/auth-helpers";
import {
  listFriendsTop,
  listNewTracks,
  listTopTracks,
  randomSeedTracks,
} from "@/lib/discover";
import {
  friendListensOf,
  friendsOf,
  pendingRequestsFor,
  suggestedFriendsFor,
} from "@/lib/friends";
import { INVITE_BLOCKED_EMAILS } from "@/lib/invites";
import { findRecommendedClusters } from "@/lib/similar";
import { getUserSettings } from "@/lib/users";
import { getSuggestedImportPool } from "@/lib/suggested-imports";
import DiscoverBrowser from "@/components/DiscoverBrowser";

export default async function DiscoverPage() {
  const user = await requirePageUser();

  // Only "Recommended" waits for Top-100: its ids both seed it and are excluded
  // from it. Everything else starts immediately. friendIdsOf and
  // getUserSettings are cache()d, so the sections share one round-trip each.
  const topPromise = listTopTracks(user.id);
  const settingsPromise = getUserSettings(user.id);
  const [
    top,
    recommended,
    random,
    friendsTop,
    newTracks,
    friends,
    requests,
    suggestions,
    ownFriendListens,
    suggestedImports,
  ] = await Promise.all([
    topPromise,
    topPromise.then((top) => {
      const topIds = top.map((t) => t.id);
      return findRecommendedClusters(user.id, topIds, {
        limit: 100,
        excludeIds: topIds,
      });
    }),
    settingsPromise.then((s) => randomSeedTracks(user.id, s.hideFriendDuplicates)),
    settingsPromise.then((s) => listFriendsTop(user.id, s.hideFriendDuplicates)),
    settingsPromise.then((s) => listNewTracks(user.id, s.hideFriendDuplicates)),
    friendsOf(user.id),
    pendingRequestsFor(user.id),
    suggestedFriendsFor(user.id),
    friendListensOf(user.id),
    getSuggestedImportPool(user.id),
  ]);

  return (
    <div className="mx-auto max-w-5xl">
      <DiscoverBrowser
        sections={{ top, recommended, random, friendsTop, newTracks }}
        friends={friends}
        requests={requests}
        suggestions={suggestions}
        ownFriendListens={ownFriendListens}
        canInvite={!INVITE_BLOCKED_EMAILS.has(user.email)}
        suggestedImports={suggestedImports}
      />
    </div>
  );
}
