"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOutAction } from "@/app/(auth)/actions";
import { usePlayerStore } from "@/stores/player";
import {
  DownloadIcon,
  ListIcon,
  LogoutIcon,
  MusicIcon,
  SettingsIcon,
  UsersIcon,
} from "@/components/icons";

const NAV = [
  { href: "/library", label: "Library", Icon: MusicIcon },
  { href: "/playlists", label: "Playlists", Icon: ListIcon },
  { href: "/friends", label: "Friends", Icon: UsersIcon },
  { href: "/downloads", label: "Downloads", Icon: DownloadIcon },
];

/** Bottom tab bar, shown below md. */
export function MobileNav() {
  const pathname = usePathname();
  return (
    <nav className="flex border-t border-border-subtle bg-surface-1 pb-[env(safe-area-inset-bottom)] md:hidden">
      {NAV.map(({ href, label, Icon }) => {
        const active = pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] ${
              active ? "text-accent-bright" : "text-fg-muted"
            }`}
          >
            <Icon size={20} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Compact top bar with logo and sign-out, shown below md. */
export function MobileTopBar() {
  return (
    <header className="flex items-center justify-between border-b border-border-subtle bg-surface-1 px-4 py-3 md:hidden">
      <Link
        href="/library"
        className="font-display text-lg font-bold tracking-tight"
      >
        <span className="text-accent-bright">Web</span>Tunes
      </Link>
      <div className="flex items-center gap-4">
        <button
          onClick={() => usePlayerStore.getState().setSettingsOpen(true)}
          aria-label="Settings"
          className="text-fg-muted hover:text-white"
        >
          <SettingsIcon size={18} />
        </button>
        <form action={signOutAction}>
          <button
            type="submit"
            aria-label="Sign out"
            className="flex items-center gap-1.5 text-xs text-fg-muted hover:text-white"
          >
            <LogoutIcon size={16} />
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
