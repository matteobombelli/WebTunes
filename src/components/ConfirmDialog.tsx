"use client";

import Dialog from "@/components/Dialog";
import { Button } from "@/components/ui/Button";
import { useConfirmStore } from "@/stores/confirm";

// Mounted once in the app layout and driven imperatively through the store.
export default function ConfirmDialog() {
  const message = useConfirmStore((s) => s.message);
  const confirmLabel = useConfirmStore((s) => s.confirmLabel);
  const settle = useConfirmStore((s) => s.settle);

  return (
    <Dialog
      title="Are you sure?"
      open={message !== null}
      onClose={() => settle(false)}
    >
      <p className="text-sm text-fg-muted">{message}</p>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => settle(false)}>
          Cancel
        </Button>
        {/* Raw button: overriding the Button primitive's bg-accent with
            bg-red-600 via className would be a Tailwind ordering coin-flip. */}
        <button
          onClick={() => settle(true)}
          className="rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-accent-fg hover:bg-red-500"
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
