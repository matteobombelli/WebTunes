import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requirePageUser } from "@/lib/auth-helpers";
import { areFriends } from "@/lib/friends";
import { listFriendTracks } from "@/lib/tracks";
import { isUuid } from "@/lib/validate";
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

  const trackDTOs = await listFriendTracks(userId, friend.name ?? friend.email);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">
          {friend.name ?? friend.email}&apos;s Library
        </h1>
        <p className="text-sm text-neutral-400">
          {trackDTOs.length} track{trackDTOs.length === 1 ? "" : "s"} shared with you
        </p>
      </div>
      <TrackList tracks={trackDTOs} />
    </div>
  );
}
