"use client";

import { useState } from "react";
import { CompassIcon, StatsIcon, UsersIcon } from "@/components/icons";
import DiscoverSection from "@/components/DiscoverSection";
import FriendsPanel from "@/components/FriendsPanel";
import StatsPanel from "@/components/StatsPanel";
import SuggestedImportsSection from "@/components/SuggestedImportsSection";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import type {
  FriendDTO,
  FriendRequestDTO,
  FriendSuggestionDTO,
  TrackDTO,
  SuggestedImportPoolDTO,
} from "@/lib/types";

type Sections = {
  top: TrackDTO[];
  recommended: TrackDTO[];
  random: TrackDTO[];
  friendsTop: TrackDTO[];
  newTracks: TrackDTO[];
};

/**
 * The Discover hub: a top-level tab switch between discovery, friends, and the
 * viewer's private listening stats.
 */
export default function DiscoverBrowser({
  sections,
  friends,
  requests,
  suggestions,
  ownFriendListens,
  canInvite,
  suggestedImports,
}: {
  sections: Sections;
  friends: FriendDTO[];
  requests: FriendRequestDTO[];
  suggestions: FriendSuggestionDTO[];
  ownFriendListens: number;
  canInvite: boolean;
  suggestedImports: SuggestedImportPoolDTO;
}) {
  const [tab, setTab] = useState<"discover" | "friends" | "stats">("discover");
  // Stats stays unmounted until first opened so Discover's initial render does
  // not issue an analytics request. It stays mounted afterward to retain its
  // per-range cache when the user switches tabs.
  const [statsVisited, setStatsVisited] = useState(false);
  const hasIncoming = requests.some((r) => r.direction === "incoming");
  const changeTab = (next: "discover" | "friends" | "stats") => {
    if (next === "stats") setStatsVisited(true);
    setTab(next);
  };

  return (
    <>
      <div className="mb-6 flex items-center justify-between gap-3">
        <h1 className="font-display text-4xl font-bold tracking-tight">
          {tab === "discover" ? "Discover" : tab === "friends" ? "Friends" : "Stats"}
        </h1>
        <SegmentedControl
          value={tab}
          onChange={changeTab}
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
            {
              value: "stats",
              label: "Stats",
              icon: <StatsIcon className="h-6 w-6 sm:h-4 sm:w-4" />,
            },
          ]}
        />
      </div>

      {tab === "discover" && (
        <div className="flex flex-col gap-4 sm:gap-5">
          <DiscoverSection title="Random" radioSeeds={sections.random} />
          <SuggestedImportsSection initialPool={suggestedImports} />
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
      )}
      {tab === "friends" && (
        <FriendsPanel
          friends={friends}
          requests={requests}
          suggestions={suggestions}
          ownFriendListens={ownFriendListens}
          canInvite={canInvite}
        />
      )}
      {statsVisited && (
        <div hidden={tab !== "stats"}>
          <StatsPanel active={tab === "stats"} />
        </div>
      )}
    </>
  );
}
