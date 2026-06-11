/** Tiny inline icon set matching the design's line-icon style. */
type P = { size?: number; className?: string };
const base = (size = 16) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

export const IconUser = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" />
  </svg>
);
export const IconUsers = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20c0-3.5 3-5 6.5-5s6.5 1.5 6.5 5" />
    <path d="M16 8.5a3 3 0 1 0 0-6" />
    <path d="M18 15.2c2.2.6 3.5 2 3.5 4.3" />
  </svg>
);
export const IconPin = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M12 21s-7-5.3-7-11a7 7 0 0 1 14 0c0 5.7-7 11-7 11z" />
    <circle cx="12" cy="10" r="2.5" />
  </svg>
);
export const IconCalendar = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <rect x="3.5" y="5" width="17" height="16" rx="3" />
    <path d="M8 3v4M16 3v4M3.5 10h17" />
  </svg>
);
export const IconClock = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3.5 2" />
  </svg>
);
export const IconStar = ({ size, className }: P) => (
  <svg {...base(size)} className={className} fill="currentColor" stroke="none">
    <path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z" />
  </svg>
);
export const IconHeart = ({ size, className, filled }: P & { filled?: boolean }) => (
  <svg {...base(size)} className={className} fill={filled ? 'currentColor' : 'none'}>
    <path d="M12 20.5S3.5 15.5 3.5 9.6A4.6 4.6 0 0 1 12 7a4.6 4.6 0 0 1 8.5 2.6c0 5.9-8.5 10.9-8.5 10.9z" />
  </svg>
);
export const IconBookmark = ({ size, className, filled }: P & { filled?: boolean }) => (
  <svg {...base(size)} className={className} fill={filled ? 'currentColor' : 'none'}>
    <path d="M6.5 3.5h11a1 1 0 0 1 1 1V21l-6.5-4L5.5 21V4.5a1 1 0 0 1 1-1z" />
  </svg>
);
export const IconCheck = ({ size, className }: P) => (
  <svg {...base(size)} className={className} strokeWidth={3}>
    <path d="M5 12.5l4.5 4.5L19 7" />
  </svg>
);
export const IconArrowRight = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M4 12h16M14 6l6 6-6 6" />
  </svg>
);
export const IconArrowLeft = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M20 12H4M10 6l-6 6 6 6" />
  </svg>
);
export const IconChevronRight = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M9 5l7 7-7 7" />
  </svg>
);
export const IconSearch = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="11" cy="11" r="7" />
    <path d="M16.5 16.5L21 21" />
  </svg>
);
export const IconShield = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M12 2.5l8 3v6c0 5-3.4 8.3-8 10-4.6-1.7-8-5-8-10v-6z" />
    <path d="M8.5 12l2.5 2.5 4.5-5" />
  </svg>
);
export const IconDollar = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="9" />
    <path d="M14.8 9.2c-.5-1-1.6-1.5-2.8-1.5-1.7 0-3 .9-3 2.2 0 2.8 6 1.6 6 4.3 0 1.3-1.3 2.2-3 2.2-1.3 0-2.5-.6-3-1.6M12 6v1.7M12 16.4V18" />
  </svg>
);
export const IconHome = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M3.5 10.5L12 3l8.5 7.5" />
    <path d="M5.5 9.5V21h13V9.5" />
  </svg>
);
export const IconBell = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M18 9a6 6 0 1 0-12 0c0 6-2.5 7-2.5 7h17S18 15 18 9z" />
    <path d="M10 20a2.2 2.2 0 0 0 4 0" />
  </svg>
);
export const IconChat = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M21 12a8 8 0 0 1-8 8H4l2-3.2A8 8 0 1 1 21 12z" />
  </svg>
);
export const IconEdit = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M4 20h4l11-11-4-4L4 16v4z" />
  </svg>
);
export const IconTrash = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M4 7h16M9 7V4.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V7M6.5 7l1 13h9l1-13" />
  </svg>
);
export const IconTrend = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M3 17l6-6 4 4 8-8" />
    <path d="M15 7h6v6" />
  </svg>
);
