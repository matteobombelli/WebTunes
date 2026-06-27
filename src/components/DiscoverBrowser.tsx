"use client";

import { useState } from "react";
import { CompassIcon, UsersIcon } from "@/components/icons";
import DiscoverSection from "@/components/DiscoverSection";
import FriendsPanel from "@/components/FriendsPanel";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import type { FriendDTO, FriendRequestDTO, TrackDTO } from "@/lib/types";

type Sections = {
  top: TrackDTO[];
  recommended: TrackDTO[];
  random: TrackDTO | null;
  friendsPlayed: TrackDTO[];
  newTracks: TrackDTO[];
};

/**
 * The Discover hub: a top-level tab switch between the five discovery sections
 * and the friends/requests panel (reused as-is, keeping its own sub-tabs).
 */
export default function DiscoverBrowser({
  sections,
  friends,
  requests,
}: {
  sections: Sections;
  friends: FriendDTO[];
  requests: FriendRequestDTO[];
}) {
  const [tab, setTab] = useState<"discover" | "friends">("discover");

  return (
    <>
      <div className="mb-6 flex items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold tracking-tight">
          {tab === "discover" ? "Discover" : "Friends"}
        </h1>
        <SegmentedControl
          value={tab}
          onChange={setTab}
          options={[
            {
              value: "discover",
              label: "Discover",
              icon: <CompassIcon size={16} />,
            },
            { value: "friends", label: "Friends", icon: <UsersIcon size={16} /> },
          ]}
        />
      </div>

      {tab === "discover" ? (
        <div className="flex flex-col gap-4 sm:gap-5">
          <DiscoverSection
            title="Random"
            description="A completely random track from your library, with play similar enabled."
            radioSeed={sections.random}
            emptyHint="No tracks yet."
          />
          <DiscoverSection
            title="Your top 100"
            description="Shuffle your top 100 tracks from the past 7 days."
            tracks={sections.top}
            emptyHint="No plays in the last 7 days."
          />
          <DiscoverSection
            title="Recommended"
            description="Shuffle a play-similar mix of your top 100."
            tracks={sections.recommended}
            emptyHint="Builds from your top 100."
          />
          <DiscoverSection
            title="Friends"
            description="Shuffle tracks your friends have played recently."
            tracks={sections.friendsPlayed}
            emptyHint="No recent plays from friends."
          />
          <DiscoverSection
            title="New tracks"
            description="Shuffle recent uploads from you and your friends."
            tracks={sections.newTracks}
            emptyHint="No tracks yet."
          />
        </div>
      ) : (
        <FriendsPanel friends={friends} requests={requests} />
      )}
    </>
  );
}
