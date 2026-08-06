import { NextRequest, NextResponse } from "next/server";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import {
  DEMO_READ_ONLY_MESSAGE,
  isDemoAccount,
} from "@/lib/demo-accounts";
import { flatExtract } from "@/lib/import/ytdlp";

const SEARCH_TAB_RESULTS = 25;
const SEARCH_TIMEOUT_MS = 60_000;

/**
 * YouTube catalog search for the Import dialog's Search tab: a flat ytsearchN
 * query - fast because nothing is resolved until the user imports a row (which
 * goes through the normal POST /api/import with the row's watch URL).
 */
export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return unauthorized();
  if (isDemoAccount(user.email)) {
    return NextResponse.json(
      { error: DEMO_READ_ONLY_MESSAGE },
      { status: 403 }
    );
  }

  const q = req.nextUrl.searchParams.get("q")?.trim().slice(0, 200);
  if (!q) {
    return NextResponse.json({ error: "Missing search query" }, { status: 400 });
  }
  try {
    const results = await flatExtract(
      `ytsearch${SEARCH_TAB_RESULTS}:${q}`,
      AbortSignal.timeout(SEARCH_TIMEOUT_MS)
    );
    return NextResponse.json(results);
  } catch {
    return NextResponse.json({ error: "YouTube search failed" }, { status: 502 });
  }
}
