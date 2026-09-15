import DownloadsBrowser from "@/components/DownloadsBrowser";

// DownloadsBrowser lives in the layout, not the page: loading.tsx wraps only
// page.tsx, so a data-free layout is part of this dynamic route's partial
// prefetch and paints the moment the tab is tapped - no RSC round trip for a
// screen whose data is entirely in IndexedDB. Staying above the boundary also
// means the page payload landing later cannot remount it (which would drop the
// opened card and sort selection). Keep this file free of server-side data.
export default function DownloadsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <DownloadsBrowser />
      {children}
    </>
  );
}
