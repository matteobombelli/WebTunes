import { forwardRef } from "react";
import {
  Pause as LucidePauseIcon,
  Play as LucidePlayIcon,
  type LucideProps,
} from "lucide-react";

/**
 * App icon aliases backed by Lucide's standard, maintained web icon set.
 * Keeping the local names gives the app one stable import surface while
 * avoiding bespoke SVG paths. Transport controls use the same Lucide shapes
 * with a solid fill so they read clearly at player-control sizes.
 */
export {
  ArrowDown as DownIcon,
  ArrowUp as UpIcon,
  ChartNoAxesColumnIncreasing as StatsIcon,
  Check as CheckIcon,
  ChevronDown as ChevronDownIcon,
  ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon,
  ChevronUp as ChevronUpIcon,
  Clock3 as ClockIcon,
  Compass as CompassIcon,
  Copy as CopyIcon,
  Download as DownloadIcon,
  EllipsisVertical as EllipsisIcon,
  Folder as FolderIcon,
  Globe as GlobeIcon,
  GripVertical as GripIcon,
  Headphones as HeadphonesIcon,
  Link as ShareIcon,
  ListMusic as QueueIcon,
  ListStart as PlayNextIcon,
  LoaderCircle as LoaderIcon,
  Lock as LockIcon,
  LogOut as LogoutIcon,
  Music2 as MusicIcon,
  Pencil as PencilIcon,
  Plus as PlusIcon,
  RefreshCw as RefreshIcon,
  Search as SearchIcon,
  Settings as SettingsIcon,
  Shuffle as ShuffleIcon,
  SkipBack as PrevIcon,
  SkipForward as NextIcon,
  Trash2 as TrashIcon,
  Users as UsersIcon,
  Volume2 as VolumeIcon,
  Waypoints as SimilarIcon,
  X as XIcon,
} from "lucide-react";

export const PlayIcon = forwardRef<SVGSVGElement, LucideProps>(
  function PlayIcon(props, ref) {
    return (
      <LucidePlayIcon
        ref={ref}
        {...props}
        fill={props.color ?? "currentColor"}
        stroke="none"
      />
    );
  }
);

export const PauseIcon = forwardRef<SVGSVGElement, LucideProps>(
  function PauseIcon(props, ref) {
    return (
      <LucidePauseIcon
        ref={ref}
        {...props}
        fill={props.color ?? "currentColor"}
        stroke="none"
      />
    );
  }
);
