"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOutAction } from "@/app/(auth)/actions";
import {
  DownloadIcon,
  ListIcon,
  LogoutIcon,
  MusicIcon,
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
    <nav className="flex border-t border-neutral-800 bg-neutral-900 pb-[env(safe-area-inset-bottom)] md:hidden">
      {NAV.map(({ href, label, Icon }) => {
        const active = pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] ${
              active ? "text-emerald-400" : "text-neutral-400"
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
    <header className="flex items-center justify-between border-b border-neutral-800 bg-neutral-900 px-4 py-3 md:hidden">
      <Link href="/library" className="text-lg font-bold tracking-tight">
        <span className="text-emerald-500">Web</span>Tunes
      </Link>
      <form action={signOutAction}>
        <button
          type="submit"
          aria-label="Sign out"
          className="flex items-center gap-1.5 text-xs text-neutral-400 hover:text-white"
        >
          <LogoutIcon size={16} />
          Sign out
        </button>
      </form>
    </header>
  );
}
