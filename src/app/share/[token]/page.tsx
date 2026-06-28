import type { Metadata } from "next";
import Link from "next/link";
import { shareArtSrc, shareStreamSrc } from "@/lib/api";
import { getAppBaseUrl } from "@/lib/app-url";
import { resolveShareToken } from "@/lib/shares";

// Public, no-auth listen page for a shared track. Lives outside the (app) and
// (auth) route groups so it inherits only the bare root layout — no
// requirePageUser, and logged-in users aren't bounced to /discover. Per-token,
// so never cached.
export const dynamic = "force-dynamic";

function displayTitle(t: { title: string; artist: string | null }): string {
  return t.artist ? `${t.title} — ${t.artist}` : t.title;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const track = await resolveShareToken(token);
  if (!track) return { title: "Shared track · WebTunes" };
  const title = displayTitle(track);
  const description = `Listen to ${title} on WebTunes`;
  // og:image must be ABSOLUTE for unfurlers; AUTH_URL (origin+basePath) in prod.
  const image = track.artS3Key
    ? `${getAppBaseUrl()}/api/share/${token}/art`
    : undefined;
  return {
    title: `${title} · WebTunes`,
    description,
    openGraph: {
      title,
      description,
      type: "music.song",
      images: image ? [image] : undefined,
    },
  };
}

export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const track = await resolveShareToken(token);

  if (!track) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="font-display text-xl font-semibold">Link unavailable</h1>
        <p className="text-fg-muted">
          This share link has expired or doesn’t exist.
        </p>
        <Link href="/" className="text-accent-bright hover:underline">
          Go to WebTunes
        </Link>
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-5 rounded-2xl border border-border bg-surface-1 p-6 shadow-2xl">
        {track.artS3Key ? (
          // eslint-disable-next-line @next/next/no-img-element -- presigned R2 redirect target; next/image can't optimize a cross-origin 302.
          <img
            src={shareArtSrc(token)}
            alt=""
            className="aspect-square w-48 rounded-xl object-cover shadow-lg"
          />
        ) : (
          <div className="flex aspect-square w-48 items-center justify-center rounded-xl bg-surface-2 text-5xl text-fg-subtle">
            ♪
          </div>
        )}
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="font-display text-xl font-semibold">{track.title}</h1>
          {track.artist && <p className="text-fg-muted">{track.artist}</p>}
          {track.album && (
            <p className="text-sm text-fg-subtle">{track.album}</p>
          )}
        </div>
        <audio controls preload="metadata" src={shareStreamSrc(token)} className="w-full" />
        <Link
          href="/"
          className="text-xs text-fg-subtle hover:text-fg-muted"
        >
          Shared via WebTunes
        </Link>
      </div>
    </main>
  );
}
