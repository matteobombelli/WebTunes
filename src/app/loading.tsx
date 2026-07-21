// Root Suspense fallback: streams instantly while the (app)/(auth) layouts'
// DB awaits run on a hard navigation or cold PWA launch, replacing the blank
// white document. Soft navigations inside (app) use the per-page loading files
// instead. Neutral by design - it also wraps the auth pages.
export default function Loading() {
  return (
    <div className="loading-stage flex min-h-dvh items-center justify-center bg-surface-0">
      <div
        role="status"
        aria-live="polite"
        className="flex flex-col items-center gap-5"
      >
        <div className="loading-record" aria-hidden="true">
          <span />
        </div>
        <div className="text-center">
          <p className="font-display text-2xl font-bold tracking-tight">
            <span className="text-accent-bright">Web</span>Tunes
          </p>
          <p className="mt-1 text-xs font-medium tracking-[0.18em] text-fg-subtle uppercase">
            Loading your library
          </p>
        </div>
      </div>
    </div>
  );
}
