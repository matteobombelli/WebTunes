"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOutAction } from "@/app/(auth)/actions";

const NAV = [
  { href: "/library", label: "Library", icon: "🎵" },
  { href: "/search", label: "Search", icon: "🔍" },
  { href: "/playlists", label: "Playlists", icon: "📂" },
  { href: "/friends", label: "Friends", icon: "👥" },
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
    <aside className="hidden w-56 shrink-0 flex-col border-r border-neutral-800 bg-neutral-900 md:flex">
      <Link href="/library" className="px-5 py-5 text-xl font-bold tracking-tight">
        <span className="text-emerald-500">Web</span>Tunes
      </Link>
      <nav className="flex flex-col gap-1 px-3">
        {NAV.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`rounded-md px-3 py-2 text-sm font-medium ${
                active
                  ? "bg-neutral-800 text-white"
                  : "text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-200"
              }`}
            >
              <span className="mr-2">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto border-t border-neutral-800 p-4">
        <p className="truncate text-sm font-medium text-neutral-200">
          {userName ?? "Account"}
        </p>
        <p className="truncate text-xs text-neutral-500">{userEmail}</p>
        <form action={signOutAction}>
          <button
            type="submit"
            className="mt-2 text-xs text-neutral-400 underline-offset-2 hover:text-white hover:underline"
          >
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
