import { and, eq, inArray, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { friendships, users } from "@/db/schema";
import { auth } from "@/lib/auth";
import { friendIdsOf } from "@/lib/friends";
import type { FriendRequestDTO } from "@/lib/types";
import FriendsPanel from "@/components/FriendsPanel";

export default async function FriendsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  const ids = await friendIdsOf(userId);
  const friends =
    ids.length === 0
      ? []
      : await db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(inArray(users.id, ids));

  const requester = alias(users, "requester");
  const addressee = alias(users, "addressee");
  const pendingRows = await db
    .select({
      id: friendships.id,
      requesterId: friendships.requesterId,
      createdAt: friendships.createdAt,
      requester: { id: requester.id, name: requester.name, email: requester.email },
      addressee: { id: addressee.id, name: addressee.name, email: addressee.email },
    })
    .from(friendships)
    .innerJoin(requester, eq(friendships.requesterId, requester.id))
    .innerJoin(addressee, eq(friendships.addresseeId, addressee.id))
    .where(
      and(
        eq(friendships.status, "pending"),
        or(eq(friendships.requesterId, userId), eq(friendships.addresseeId, userId))
      )
    );

  const requests: FriendRequestDTO[] = pendingRows.map((r) => ({
    id: r.id,
    direction: r.requesterId === userId ? "outgoing" : "incoming",
    user: r.requesterId === userId ? r.addressee : r.requester,
    createdAt: r.createdAt.toISOString(),
  }));

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-6 text-2xl font-bold">Friends</h1>
      <FriendsPanel friends={friends} requests={requests} />
    </div>
  );
}
