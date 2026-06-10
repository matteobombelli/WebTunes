export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 text-neutral-200">
      <div className="w-full max-w-sm rounded-xl border border-neutral-800 bg-neutral-900 p-8 shadow-xl">
        <h1 className="mb-6 text-center text-2xl font-bold tracking-tight">
          <span className="text-emerald-500">Web</span>Tunes
        </h1>
        {children}
      </div>
    </div>
  );
}
