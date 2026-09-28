import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { oauthClients, oauthGrants, oauthTokens } from "@/db/schema";
import { isCimdClientId } from "@/lib/oauth/clients";
import type { OAuthGrantDTO } from "@/lib/types";
import { isUuid } from "@/lib/validate";

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export async function listGrants(userId: string): Promise<OAuthGrantDTO[]> {
  const rows = await db
    .select({
      id: oauthGrants.id,
      clientId: oauthClients.id,
      clientName: oauthClients.name,
      clientUri: oauthClients.clientUri,
      scopes: oauthGrants.scopes,
      createdAt: oauthGrants.createdAt,
      lastUsedAt: oauthGrants.lastUsedAt,
    })
    .from(oauthGrants)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
    .where(
      and(
        eq(oauthGrants.userId, userId),
        // Grants whose tokens all expired or were revoked (code replay) are
        // dead until the daily purge deletes them; don't show them as connected.
        sql`exists (select 1 from ${oauthTokens} where ${oauthTokens.grantId} = ${oauthGrants.id} and ${oauthTokens.expiresAt} > now() and ${oauthTokens.usedAt} is null)`
      )
    )
    .orderBy(desc(oauthGrants.createdAt));
  return rows.map((r) => ({
    id: r.id,
    clientName: r.clientName,
    clientHost: r.clientUri
      ? hostOf(r.clientUri)
      : isCimdClientId(r.clientId)
        ? hostOf(r.clientId)
        : null,
    scopes: r.scopes,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  }));
}

/** Deleting the grant cascades its tokens and codes; its MCP actions stay
 * undoable (grant_id is SET NULL). */
export async function revokeGrant(
  userId: string,
  grantId: string
): Promise<boolean> {
  if (!isUuid(grantId)) return false;
  const deleted = await db
    .delete(oauthGrants)
    .where(and(eq(oauthGrants.id, grantId), eq(oauthGrants.userId, userId)))
    .returning({ id: oauthGrants.id });
  return deleted.length > 0;
}
