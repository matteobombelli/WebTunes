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
  random: TrackDTO[];
  friendsTop: TrackDTO[];
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
  canInvite,
}: {
  sections: Sections;
  friends: FriendDTO[];
  requests: FriendRequestDTO[];
  canInvite: boolean;
}) {
  const [tab, setTab] = useState<"discover" | "friends">("discover");
  const hasIncoming = requests.some((r) => r.direction === "incoming");

  return (
    <>
      <div className="mb-6 flex items-center justify-between gap-3">
        <h1 className="font-display text-4xl font-bold tracking-tight">
          {tab === "discover" ? "Discover" : "Friends"}
        </h1>
        <SegmentedControl
          value={tab}
          onChange={setTab}
          size="lg"
          options={[
            {
              value: "discover",
              label: "Discover",
              icon: <CompassIcon className="h-6 w-6 sm:h-4 sm:w-4" />,
            },
            {
              value: "friends",
              label: "Friends",
              icon: <UsersIcon className="h-6 w-6 sm:h-4 sm:w-4" />,
              dot: hasIncoming,
            },
          ]}
        />
      </div>

      {tab === "discover" ? (
        <div className="flex flex-col gap-4 sm:gap-5">
          <DiscoverSection title="Random" radioSeeds={sections.random} />
          <DiscoverSection
            title="Recommended"
            tracks={sections.recommended}
            emptyHint="Builds from your top 100."
          />
          <DiscoverSection
            title="Your top 100"
            tracks={sections.top}
            emptyHint="No plays yet."
          />
          <DiscoverSection
            title="Friends Top 100"
            tracks={sections.friendsTop}
            emptyHint="No friend activity yet."
          />
          <DiscoverSection
            title="New tracks"
            tracks={sections.newTracks}
            emptyHint="No tracks yet."
          />
        </div>
      ) : (
        <FriendsPanel
          friends={friends}
          requests={requests}
          canInvite={canInvite}
        />
      )}
    </>
  );
}
