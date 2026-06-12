import DownloadsBrowser from "@/components/DownloadsBrowser";

// This page must render fully offline: all data comes from IndexedDB in the
// client component. Keep it free of server-side data fetching.
export default function DownloadsPage() {
  return <DownloadsBrowser />;
}
