// Inline SVG icons sharing one viewBox so glyphs render at identical sizes
// (fixes play/pause width jump). Sized by the parent via the size prop.

type IconProps = { size?: number; className?: string };

function Svg({
  size = 20,
  className,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  );
}

export const PlayIcon = (p: IconProps) => (
  <Svg {...p}>
    {/* Glyph spans x 6.5–18.5: centered with a 0.5 optical right bias. */}
    <path d="M6.5 5.14v13.72c0 .9.98 1.45 1.74.98l10.3-6.86a1.15 1.15 0 0 0 0-1.96L8.24 4.16a1.15 1.15 0 0 0-1.74.98z" />
  </Svg>
);

export const PauseIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6" y="5" width="4" height="14" rx="1" />
    <rect x="14" y="5" width="4" height="14" rx="1" />
  </Svg>
);

export const PrevIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5" y="5" width="3" height="14" rx="1" />
    <path d="M19 5.86v12.28c0 .86-.93 1.4-1.68.97l-9.07-6.14a1.13 1.13 0 0 1 0-1.94l9.07-6.14c.75-.43 1.68.11 1.68.97z" />
  </Svg>
);

export const NextIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="16" y="5" width="3" height="14" rx="1" />
    <path d="M5 5.86v12.28c0 .86.93 1.4 1.68.97l9.07-6.14a1.13 1.13 0 0 0 0-1.94L6.68 4.89C5.93 4.46 5 5 5 5.86z" />
  </Svg>
);

export const VolumeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9.5v5c0 .55.45 1 1 1h2.6l3.7 3.1c.65.55 1.7.1 1.7-.76V6.16c0-.86-1.05-1.3-1.7-.76L7.6 8.5H5c-.55 0-1 .45-1 1z" />
    <path d="M16 8.7a5 5 0 0 1 0 6.6 1 1 0 1 0 1.5 1.3 7 7 0 0 0 0-9.2A1 1 0 0 0 16 8.7z" />
  </Svg>
);

export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M11 5a1 1 0 1 1 2 0v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6H5a1 1 0 1 1 0-2h6V5z" />
  </Svg>
);

export const XIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.2 6.2a1 1 0 0 1 1.4 0L12 10.6l4.4-4.4a1 1 0 1 1 1.4 1.4L13.4 12l4.4 4.4a1 1 0 0 1-1.4 1.4L12 13.4l-4.4 4.4a1 1 0 0 1-1.4-1.4L10.6 12 6.2 7.6a1 1 0 0 1 0-1.4z" />
  </Svg>
);

export const PencilIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M16.9 4.3a2 2 0 0 1 2.8 2.8l-9.9 9.9-3.5.7a.5.5 0 0 1-.6-.6l.7-3.5 9.9-9.9.6.6z" />
  </Svg>
);

export const LockIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 10V8a5 5 0 0 1 10 0v2h.5A1.5 1.5 0 0 1 19 11.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18.5v-7A1.5 1.5 0 0 1 6.5 10H7zm2 0h6V8a3 3 0 0 0-6 0v2z" />
  </Svg>
);

export const MusicIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 5.5a1 1 0 0 1 .76-.97l8-2A1 1 0 0 1 19 3.5V15a3 3 0 1 1-2-2.83V6.78l-6 1.5V17a3 3 0 1 1-2-2.83V5.5z" />
  </Svg>
);

export const SearchIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.5 3a7.5 7.5 0 1 0 4.55 13.46l4.25 4.25a1 1 0 0 0 1.4-1.42l-4.24-4.24A7.5 7.5 0 0 0 10.5 3zm-5.5 7.5a5.5 5.5 0 1 1 11 0 5.5 5.5 0 0 1-11 0z" />
  </Svg>
);

export const ListIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6a1 1 0 0 1 1-1h14a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1zm0 6a1 1 0 0 1 1-1h14a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1zm1 5a1 1 0 1 0 0 2h9a1 1 0 1 0 0-2H5z" />
  </Svg>
);

export const UsersIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM3 19a6 6 0 0 1 12 0v1H3v-1zm13.5-7a3.5 3.5 0 1 0-2.04-6.34 6 6 0 0 1 0 5.68A3.48 3.48 0 0 0 16.5 12zm.5 2c-.45 0-.89.06-1.3.18A7.97 7.97 0 0 1 17 19v1h4v-1a5 5 0 0 0-4-5z" />
  </Svg>
);

export const DownloadIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3a1 1 0 0 1 1 1v8.59l2.3-2.3a1 1 0 1 1 1.4 1.42l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.42l2.3 2.3V4a1 1 0 0 1 1-1z" />
    <rect x="4" y="18" width="16" height="2" rx="1" />
  </Svg>
);

export const LogoutIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 4a1 1 0 0 1 0 2H7v12h3a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h4zm5.3 3.3a1 1 0 0 1 1.4 0l4 4a1 1 0 0 1 0 1.4l-4 4a1 1 0 0 1-1.4-1.4L17.58 13H11a1 1 0 1 1 0-2h6.59l-2.3-2.3a1 1 0 0 1 0-1.4z" />
  </Svg>
);

/** Filled chevrons for sort indicators (UpIcon/DownIcon are move arrows). */
export const ChevronUpIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 7l7 9H5l7-9z" />
  </Svg>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 17L5 8h14l-7 9z" />
  </Svg>
);

export const UpIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5l6 7h-4v7h-4v-7H6l6-7z" />
  </Svg>
);

export const DownIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 19l-6-7h4V5h4v7h4l-6 7z" />
  </Svg>
);
