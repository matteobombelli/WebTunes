// Root Suspense fallback: streams instantly while the (app)/(auth) layouts'
// DB awaits run on a hard navigation or cold PWA launch, replacing the blank
// white document. Soft navigations inside (app) use the per-page loading files
// instead. Neutral by design — it also wraps the auth pages.
export default function Loading() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface-0">
      <span className="animate-pulse font-display text-3xl font-bold tracking-tight">
        <span className="text-accent-bright">Web</span>Tunes
      </span>
    </div>
  );
}
