export async function register() {
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.NEXT_PHASE !== "phase-production-build"
  ) {
    const { startSuggestedImportWorker } = await import("@/lib/suggested-imports");
    startSuggestedImportWorker();
  }
}
