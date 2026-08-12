const STORAGE_KEY = "wt-queue-window";
const FRAME_GAP = 8;
const MIN_FRAME_WIDTH = 320;

export const MIN_FRAME_HEIGHT = 260;
export const DEFAULT_FRAME_HEIGHT = 560;
export const COLLAPSED_FRAME_EXTRA_HEIGHT = 116;

const DEFAULT_FRAME_WIDTH = 416;

export type DesktopFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ResizeDirection =
  | "n"
  | "ne"
  | "e"
  | "se"
  | "s"
  | "sw"
  | "w"
  | "nw";

export const RESIZE_HANDLES: {
  direction: ResizeDirection;
  label: string;
  className: string;
}[] = [
  {
    direction: "n",
    label: "top edge",
    className: "left-4 right-4 top-0 h-2 cursor-ns-resize",
  },
  {
    direction: "e",
    label: "right edge",
    className: "bottom-4 right-0 top-4 w-2 cursor-ew-resize",
  },
  {
    direction: "s",
    label: "bottom edge",
    className: "bottom-0 left-4 right-4 h-2 cursor-ns-resize",
  },
  {
    direction: "w",
    label: "left edge",
    className: "bottom-4 left-0 top-4 w-2 cursor-ew-resize",
  },
  {
    direction: "nw",
    label: "top-left corner",
    className: "left-0 top-0 h-4 w-4 cursor-nwse-resize",
  },
  {
    direction: "ne",
    label: "top-right corner",
    className: "right-0 top-0 h-4 w-4 cursor-nesw-resize",
  },
  {
    direction: "se",
    label: "bottom-right corner",
    className: "bottom-0 right-0 h-4 w-4 cursor-nwse-resize",
  },
  {
    direction: "sw",
    label: "bottom-left corner",
    className: "bottom-0 left-0 h-4 w-4 cursor-nesw-resize",
  },
];

export function resizeDesktopFrame(
  frame: DesktopFrame,
  direction: ResizeDirection,
  dx: number,
  dy: number
): DesktopFrame {
  const viewportLeft = FRAME_GAP;
  const viewportTop = FRAME_GAP;
  const viewportRight = window.innerWidth - FRAME_GAP;
  const viewportBottom = window.innerHeight - FRAME_GAP;
  const minWidth = Math.min(MIN_FRAME_WIDTH, viewportRight - viewportLeft);
  const minHeight = Math.min(MIN_FRAME_HEIGHT, viewportBottom - viewportTop);
  let left = frame.x;
  let right = frame.x + frame.width;
  let top = frame.y;
  let bottom = frame.y + frame.height;

  if (direction.includes("w")) {
    left = Math.min(right - minWidth, Math.max(viewportLeft, left + dx));
  } else if (direction.includes("e")) {
    right = Math.max(left + minWidth, Math.min(viewportRight, right + dx));
  }
  if (direction.includes("n")) {
    top = Math.min(bottom - minHeight, Math.max(viewportTop, top + dy));
  } else if (direction.includes("s")) {
    bottom = Math.max(top + minHeight, Math.min(viewportBottom, bottom + dy));
  }

  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function clampDesktopFrame(
  frame: DesktopFrame,
  minHeight = MIN_FRAME_HEIGHT
): DesktopFrame {
  const maxWidth = Math.max(1, window.innerWidth - FRAME_GAP * 2);
  const maxHeight = Math.max(1, window.innerHeight - FRAME_GAP * 2);
  const width = Math.min(
    maxWidth,
    Math.max(Math.min(MIN_FRAME_WIDTH, maxWidth), frame.width)
  );
  const height = Math.min(
    maxHeight,
    Math.max(Math.min(minHeight, maxHeight), frame.height)
  );
  return {
    width,
    height,
    x: Math.min(
      window.innerWidth - width - FRAME_GAP,
      Math.max(FRAME_GAP, frame.x)
    ),
    y: Math.min(
      window.innerHeight - height - FRAME_GAP,
      Math.max(FRAME_GAP, frame.y)
    ),
  };
}

export function initialDesktopFrame(): DesktopFrame {
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? "null"
    ) as Partial<DesktopFrame> | null;
    if (
      stored &&
      [stored.x, stored.y, stored.width, stored.height].every(Number.isFinite)
    ) {
      return clampDesktopFrame(stored as DesktopFrame);
    }
  } catch {
    // Unavailable or corrupt storage falls back to the player-bar anchor.
  }

  const width = Math.min(
    DEFAULT_FRAME_WIDTH,
    window.innerWidth - FRAME_GAP * 2
  );
  const height = Math.min(
    DEFAULT_FRAME_HEIGHT,
    window.innerHeight - FRAME_GAP * 2
  );
  return clampDesktopFrame({
    x: 232,
    y: window.innerHeight - height - 80,
    width,
    height,
  });
}

export function saveDesktopFrame(frame: DesktopFrame): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(frame));
  } catch {
    // Persisting window geometry is best-effort.
  }
}
