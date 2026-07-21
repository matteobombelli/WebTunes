import { NextResponse } from "next/server";
import { requireUser, unauthorized } from "@/lib/auth-helpers";
import {
  getSuggestedImportPool,
  wakeSuggestedImportWorker,
} from "@/lib/suggested-imports";

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();
  const pool = await getSuggestedImportPool(user.id);
  if (pool.items.length < pool.target) wakeSuggestedImportWorker();
  return NextResponse.json(pool);
}
