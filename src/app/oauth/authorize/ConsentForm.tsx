"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { DEMO_READ_ONLY_MESSAGE } from "@/lib/demo-accounts";
import { consentAction } from "./actions";

export function ConsentForm({
  params,
  writeRequested,
  demo,
}: {
  params: Record<string, string>;
  writeRequested: boolean;
  demo: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [navigating, setNavigating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The CSP's form-action 'self' also applies to redirects that follow a form
  // submission, so the external redirect_uri is navigated to from script.
  const submit = (formData: FormData) =>
    startTransition(async () => {
      const result = await consentAction(formData);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setNavigating(true);
      window.location.assign(result.redirectTo);
    });

  const busy = pending || navigating;

  return (
    <form action={submit} className="flex flex-col gap-4">
      {Object.entries(params).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <fieldset className="flex flex-col gap-2">
        <label className="flex items-start gap-2 text-sm text-fg">
          <input type="checkbox" checked disabled className="checkbox mt-0.5" />
          Read your library, playlists, stats and friends’ shared music
        </label>
        {writeRequested && (
          <label className="flex items-start gap-2 text-sm text-fg">
            <input
              type="checkbox"
              name="write"
              defaultChecked={!demo}
              disabled={demo}
              className="checkbox mt-0.5"
            />
            <span>
              Make changes (every change can be undone for 30 days)
              {demo && (
                <span className="block text-fg-muted">{DEMO_READ_ONLY_MESSAGE}</span>
              )}
            </span>
          </label>
        )}
      </fieldset>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex gap-2">
        <Button
          type="submit"
          name="decision"
          value="deny"
          variant="outline"
          disabled={busy}
          className="flex-1"
        >
          Deny
        </Button>
        <Button
          type="submit"
          name="decision"
          value="allow"
          disabled={busy}
          className="flex-1"
        >
          {busy ? "Redirecting…" : "Allow"}
        </Button>
      </div>
    </form>
  );
}
