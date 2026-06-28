"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOutAction } from "@/app/(auth)/actions";
import { usePlayerStore } from "@/stores/player";
import {
  CompassIcon,
  DownloadIcon,
  ListIcon,
  LogoutIcon,
  MusicIcon,
  SettingsIcon,
} from "@/components/icons";
import { NotificationDot } from "@/components/ui/NotificationDot";

const NAV = [
  { href: "/discover", label: "Discover", Icon: CompassIcon },
  { href: "/playlists", label: "Playlists", Icon: ListIcon },
  { href: "/library", label: "Library", Icon: MusicIcon },
  { href: "/downloads", label: "Downloads", Icon: DownloadIcon },
];

/** Bottom tab bar, shown below md. */
export function MobileNav({
  hasIncomingRequests = false,
}: {
  hasIncomingRequests?: boolean;
}) {
  const pathname = usePathname();
  return (
    <nav className="flex border-t border-border-subtle bg-surface-1 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] md:hidden">
      {NAV.map(({ href, label, Icon }) => {
        const active = pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            prefetch
            aria-label={label}
            className={`flex flex-1 items-center justify-center py-3 ${
              active ? "text-accent-bright" : "text-fg-muted"
            }`}
          >
            <span className="relative flex items-center justify-center">
              <Icon size={26} />
              {href === "/discover" && hasIncomingRequests && (
                <NotificationDot overlay />
              )}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

/** Compact top bar with logo and sign-out, shown below md. */
export function MobileTopBar() {
  return (
    <header className="flex items-center justify-between border-b border-border-subtle bg-surface-1 px-4 py-4 md:hidden">
      <Link
        href="/discover"
        className="font-display text-xl font-bold tracking-tight"
      >
        <span className="text-accent-bright">Web</span>Tunes
      </Link>
      <div className="flex items-center gap-4">
        <button
          onClick={() => usePlayerStore.getState().setSettingsOpen(true)}
          aria-label="Settings"
          className="flex items-center text-fg-muted hover:text-white"
        >
          <SettingsIcon size={22} />
        </button>
        <form action={signOutAction}>
          <button
            type="submit"
            aria-label="Sign out"
            className="flex items-center text-fg-muted hover:text-white"
          >
            <LogoutIcon size={22} />
          </button>
        </form>
      </div>
    </header>
  );
}
