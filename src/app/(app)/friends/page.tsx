import { requirePageUser } from "@/lib/auth-helpers";
import { friendsOf, pendingRequestsFor } from "@/lib/friends";
import FriendsPanel from "@/components/FriendsPanel";

export default async function FriendsPage() {
  const user = await requirePageUser();
  const [friends, requests] = await Promise.all([
    friendsOf(user.id),
    pendingRequestsFor(user.id),
  ]);

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-6 text-2xl font-bold">Friends</h1>
      <FriendsPanel friends={friends} requests={requests} />
    </div>
  );
}
