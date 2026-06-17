"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOutAction } from "@/app/(auth)/actions";
import {
  DownloadIcon,
  FolderIcon,
  MusicIcon,
  UsersIcon,
} from "@/components/icons";

const NAV = [
  { href: "/library", label: "Library", Icon: MusicIcon },
  { href: "/playlists", label: "Playlists", Icon: FolderIcon },
  { href: "/friends", label: "Friends", Icon: UsersIcon },
  { href: "/downloads", label: "Downloads", Icon: DownloadIcon },
];

export default function Sidebar({
  userName,
  userEmail,
}: {
  userName: string | null;
  userEmail: string;
}) {
  const pathname = usePathname();

  return (
    <aside className="hidden w-56 shrink-0 flex-col border-r border-border-subtle bg-surface-1 md:flex">
      <Link
        href="/library"
        className="px-5 py-5 font-display text-xl font-bold tracking-tight"
      >
        <span className="text-accent-bright">Web</span>Tunes
      </Link>
      <nav className="flex flex-col gap-1 px-3">
        {NAV.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                active
                  ? "bg-accent/10 text-accent-bright"
                  : "text-fg-muted hover:bg-surface-2/60 hover:text-fg"
              }`}
            >
              <item.Icon size={16} />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto border-t border-border-subtle p-4">
        <p className="truncate text-sm font-medium text-fg">
          {userName ?? "Account"}
        </p>
        <p className="truncate text-xs text-fg-subtle">{userEmail}</p>
        <form action={signOutAction}>
          <button
            type="submit"
            className="mt-2 text-xs text-fg-muted underline-offset-2 hover:text-white hover:underline"
          >
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
