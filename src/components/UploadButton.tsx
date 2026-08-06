"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/Button";
import { DEMO_READ_ONLY_MESSAGE } from "@/lib/demo-accounts";
import { useToastStore } from "@/stores/toast";
import { useUploadsStore } from "@/stores/uploads";

export default function UploadButton({
  readOnly = false,
}: {
  readOnly?: boolean;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = useUploadsStore((s) => s.busy);
  const start = useUploadsStore((s) => s.start);

  // Refresh the server-rendered library list once a batch finishes. Lives here
  // (not in the store) because only a mounted page can call the router; if the
  // user is elsewhere when it finishes, navigating back refetches anyway.
  const prevBusy = useRef(busy);
  useEffect(() => {
    if (prevBusy.current && !busy) router.refresh();
    prevBusy.current = busy;
  }, [busy, router]);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="audio/*,.mp3,.m4a,.flac,.ogg,.opus,.wav"
        multiple
        hidden
        onChange={(e) => {
          if (readOnly) {
            useToastStore.getState().show(DEMO_READ_ONLY_MESSAGE);
          } else if (e.target.files) {
            start(Array.from(e.target.files));
          }
          e.target.value = ""; // allow re-selecting the same file
        }}
      />
      <Button
        onClick={() => {
          if (readOnly) {
            useToastStore.getState().show(DEMO_READ_ONLY_MESSAGE);
            return;
          }
          inputRef.current?.click();
        }}
        disabled={busy}
      >
        {busy ? "Uploading…" : "Upload"}
      </Button>
    </>
  );
}
