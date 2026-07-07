import { GlobeIcon, MusicIcon, UsersIcon } from "@/components/icons";

/** The own/all/friends scope options shared by the library and playlist
 *  browsers (pairs with usePersistedScope). */
export const SCOPES = [
  { value: "own", label: "My library", icon: <MusicIcon size={17} /> },
  { value: "all", label: "Everything", icon: <GlobeIcon size={17} /> },
  { value: "friends", label: "Friends", icon: <UsersIcon size={17} /> },
] as const;
