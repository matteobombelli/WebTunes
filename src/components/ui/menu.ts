// Shared class strings for the app's dropdown/kebab menus, so the copies in
// TrackList's menus and DownloadButton's playlist states can't drift apart.

/** A non-interactive row inside a dropdown/kebab menu (e.g. a progress line). */
export const MENU_ROW_STATIC =
  "flex w-full items-center justify-between gap-3 rounded-md bg-surface-2/40 px-3 py-2.5 text-left";

/** A clickable row inside a dropdown/kebab menu. */
export const MENU_ROW = `${MENU_ROW_STATIC} hover:bg-surface-3/60`;

/** The dropdown/popover shell (sites append width/padding/positioning). */
export const MENU_CHROME = "rounded-md border border-border bg-surface-2 text-sm shadow-lg";
