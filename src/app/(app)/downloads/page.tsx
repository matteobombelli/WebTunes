// The UI lives in layout.tsx (above this route's loading boundary) so the page
// paints from Next's partial prefetch without waiting on an RSC round trip.
export default function DownloadsPage() {
  return null;
}
