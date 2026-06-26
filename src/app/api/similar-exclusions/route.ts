import { NextResponse } from "next/server";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import { listExcludedTracks } from "@/lib/exclusions";

// The caller's "exclude from Play Similar" list (full DTOs, newest first), for
// the Settings sub-view and to seed the client exclusions store on app load.
export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();

  const tracks = await listExcludedTracks(user.id);
  return NextResponse.json({ tracks });
}
