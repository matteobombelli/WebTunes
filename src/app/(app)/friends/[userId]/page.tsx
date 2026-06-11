import { and, desc, eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { db } from "@/db";
import { tracks, users } from "@/db/schema";
import { auth } from "@/lib/auth";
import { areFriends } from "@/lib/friends";
import type { TrackDTO } from "@/lib/types";
import TrackList from "@/components/TrackList";

export default async function FriendLibraryPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { userId } = await params;
  if (!(await areFriends(session.user.id, userId))) notFound();

  const [friend] = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  if (!friend) notFound();

  const rows = await db
    .select()
    .from(tracks)
    .where(and(eq(tracks.ownerId, userId), eq(tracks.isPrivate, false)))
    .orderBy(desc(tracks.createdAt));

  const trackDTOs: TrackDTO[] = rows.map((t) => ({
    ...t,
    createdAt: t.createdAt.toISOString(),
    ownerName: friend.name ?? friend.email,
  }));

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
