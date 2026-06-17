export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-0 text-fg">
      <div className="w-full max-w-sm rounded-xl border border-border-subtle bg-surface-1 p-8 shadow-xl">
        <h1 className="mb-6 text-center font-display text-2xl font-bold tracking-tight">
          <span className="text-accent-bright">Web</span>Tunes
        </h1>
        {children}
      </div>
    </div>
  );
}
