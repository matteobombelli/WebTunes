"use server";

import { requireUser } from "@/lib/auth-helpers";
import { isDemoAccount } from "@/lib/demo-accounts";
import {
  authorizationResponseUrl,
  checkAuthorizeRequest,
  issueAuthorizationCode,
  pickAuthorizeParams,
} from "@/lib/oauth/authorize";

export type ConsentResult = { redirectTo: string } | { error: string };

// Hidden fields only carry the original request back; everything is validated
// again here, since the form post is the real trust boundary.
export async function consentAction(formData: FormData): Promise<ConsentResult> {
  const user = await requireUser();
  if (!user) return { error: "Your session expired. Reload the page to sign in again." };

  const params = pickAuthorizeParams((name) => {
    const value = formData.get(name);
    return typeof value === "string" ? value : undefined;
  });
  const check = await checkAuthorizeRequest(params);
  if (check.kind === "error_page") return { error: check.message };

  if (formData.get("decision") !== "allow") {
    return {
      redirectTo: authorizationResponseUrl(check.redirectUri, {
        error: "access_denied",
        error_description: "The user denied access",
        state: check.state,
      }),
    };
  }

  const allowWrite =
    formData.get("write") === "on" && !isDemoAccount(user.email);
  const scopes = check.scopes.filter(
    (s) => s === "library:read" || allowWrite
  );
  if (!scopes.includes("library:read")) scopes.unshift("library:read");

  const code = await issueAuthorizationCode({
    userId: user.id,
    clientId: check.client.id,
    scopes,
    redirectUri: check.redirectUri,
    codeChallenge: check.codeChallenge,
  });
  return {
    redirectTo: authorizationResponseUrl(check.redirectUri, {
      code,
      state: check.state,
    }),
  };
}
