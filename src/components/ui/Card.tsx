/** Shared card shell with a subtle hover-lift, as a class string so it works
 *  on any element (<li>, <Link>, …). */
export const cardClass =
  "rounded-lg border border-border-subtle bg-surface-1 transition duration-150 " +
  "hover:-translate-y-0.5 hover:border-border hover:bg-surface-2/60 " +
  "hover:shadow-lg hover:shadow-black/30";

/** A static list row (friends, requests, invites): card surface without the
 *  hover-lift. */
export const listRowClass =
  "flex items-center gap-3 rounded-md border border-border-subtle bg-surface-1 px-4 py-2";
