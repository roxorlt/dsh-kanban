import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconBoard = (props: IconProps) => (
  <Svg {...props}>
    <rect x="2" y="3" width="3.2" height="10" rx="1" />
    <rect x="6.4" y="3" width="3.2" height="7" rx="1" />
    <rect x="10.8" y="3" width="3.2" height="10" rx="1" />
  </Svg>
);

export const IconList = (props: IconProps) => (
  <Svg {...props}>
    <path d="M5.5 4h8.5M5.5 8h8.5M5.5 12h8.5" />
    <path d="M2.2 4h.01M2.2 8h.01M2.2 12h.01" strokeWidth={2} />
  </Svg>
);

export const IconSearch = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="7" cy="7" r="4.2" />
    <path d="m10.2 10.2 3 3" />
  </Svg>
);

export const IconPlus = (props: IconProps) => (
  <Svg {...props}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);

export const IconChevronDown = (props: IconProps) => (
  <Svg {...props}>
    <path d="m4 6 4 4 4-4" />
  </Svg>
);

export const IconChevronUp = (props: IconProps) => (
  <Svg {...props}>
    <path d="m4 10 4-4 4 4" />
  </Svg>
);

export const IconChevronRight = (props: IconProps) => (
  <Svg {...props}>
    <path d="m6 4 4 4-4 4" />
  </Svg>
);

export const IconMore = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 8h.01M8 8h.01M12 8h.01" strokeWidth={2.2} />
  </Svg>
);

export const IconCheck = (props: IconProps) => (
  <Svg {...props}>
    <path d="m3.5 8.5 3 3 6-7" />
  </Svg>
);

export const IconClose = (props: IconProps) => (
  <Svg {...props}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Svg>
);

export const IconClock = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v3.2l2 1.2" />
  </Svg>
);

export const IconWrench = (props: IconProps) => (
  <Svg {...props}>
    <path d="M10.4 2.6a3.6 3.6 0 0 0-3.9 5.1L2.8 11.4a1.4 1.4 0 0 0 2 2l3.7-3.7a3.6 3.6 0 0 0 5.1-3.9l-2 2-1.9-.5-.5-1.9 2-2Z" />
  </Svg>
);

export const IconSparkle = (props: IconProps) => (
  <Svg {...props}>
    <path d="M8 2.5 9.3 6 12.8 7.3 9.3 8.6 8 12.1 6.7 8.6 3.2 7.3 6.7 6 8 2.5Z" />
  </Svg>
);

export const IconAlert = (props: IconProps) => (
  <Svg {...props}>
    <path d="M8 2.8 14 13H2L8 2.8Z" />
    <path d="M8 6.4v3.1M8 11.6h.01" />
  </Svg>
);

export const IconError = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="8" cy="8" r="5.6" />
    <path d="M8 5.2v3.4M8 11h.01" />
  </Svg>
);

export const IconInfo = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="8" cy="8" r="5.6" />
    <path d="M8 7.4V11M8 5.1h.01" />
  </Svg>
);

export const IconCheckCircle = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="8" cy="8" r="5.6" />
    <path d="m5.4 8.1 1.8 1.8 3.4-4" />
  </Svg>
);

export const IconArchive = (props: IconProps) => (
  <Svg {...props}>
    <rect x="2.2" y="3" width="11.6" height="3" rx="1" />
    <path d="M3.4 6v5.4a1.6 1.6 0 0 0 1.6 1.6h6a1.6 1.6 0 0 0 1.6-1.6V6M6.5 8.6h3" />
  </Svg>
);

export const IconEdit = (props: IconProps) => (
  <Svg {...props}>
    <path d="M9.6 2.9 13.1 6.4 6 13.5l-3.8.7.7-3.8 6.7-7.5Z" />
    <path d="m8.4 4.1 3.5 3.5" />
  </Svg>
);

export const IconMove = (props: IconProps) => (
  <Svg {...props}>
    <path d="M2.5 8h11M10 4.5 13.5 8 10 11.5M6 4.5 2.5 8 6 11.5" />
  </Svg>
);

export const IconReply = (props: IconProps) => (
  <Svg {...props}>
    <path d="M13.5 8.6c0 2.1-2.4 3.8-5.5 3.8-.7 0-1.4-.1-2-.3l-3 .9.9-2.5a3.4 3.4 0 0 1-.9-2.2c0-2.1 2.4-3.8 5.5-3.8s5 1.7 5 3.8Z" />
  </Svg>
);

export const IconRefresh = (props: IconProps) => (
  <Svg {...props}>
    <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7M13.4 2.8v3h-3" />
  </Svg>
);

export const IconCopy = (props: IconProps) => (
  <Svg {...props}>
    <rect x="5.4" y="5.4" width="7.4" height="7.4" rx="1.4" />
    <path d="M10.6 5.4V4.2a1.4 1.4 0 0 0-1.4-1.4H4.2a1.4 1.4 0 0 0-1.4 1.4v5a1.4 1.4 0 0 0 1.4 1.4h1.2" />
  </Svg>
);

export const IconLink = (props: IconProps) => (
  <Svg {...props}>
    <path d="M6.6 9.4a2.6 2.6 0 0 0 3.7 0l2.3-2.3a2.6 2.6 0 0 0-3.7-3.7l-1 1" />
    <path d="M9.4 6.6a2.6 2.6 0 0 0-3.7 0L3.4 8.9a2.6 2.6 0 0 0 3.7 3.7l1-1" />
  </Svg>
);

export const IconFile = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 2.5h5l3 3v8H4v-11Z" />
    <path d="M9 2.5v3h3" />
  </Svg>
);

export const IconCommit = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="8" cy="8" r="3.2" />
    <path d="M1.8 8h3M11.2 8h3" />
  </Svg>
);

export const IconImage = (props: IconProps) => (
  <Svg {...props}>
    <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
    <circle cx="6" cy="6.6" r="1" />
    <path d="m3.4 11.6 3.2-3 2.2 2 1.8-1.7 2 2.7" />
  </Svg>
);

export const IconReport = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 2.5h8v11H4v-11Z" />
    <path d="M6 6h4M6 8.4h4M6 10.8h2.4" />
  </Svg>
);

export const IconOpen = (props: IconProps) => (
  <Svg {...props}>
    <path d="M9 2.8h4.2V7M13 3 7.6 8.4" />
    <path d="M12 9.6v3.1a.9.9 0 0 1-.9.9H3.3a.9.9 0 0 1-.9-.9V4.9a.9.9 0 0 1 .9-.9h3.1" />
  </Svg>
);

export const IconSession = (props: IconProps) => (
  <Svg {...props}>
    <path d="M3 4.6h10v6.2H7.6L4.4 13v-2.2H3V4.6Z" />
  </Svg>
);

export const IconGlobe = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="8" cy="8" r="5.6" />
    <path d="M2.6 8h10.8M8 2.4c1.6 1.6 2.4 3.5 2.4 5.6S9.6 12 8 13.6C6.4 12 5.6 10.1 5.6 8S6.4 4 8 2.4Z" />
  </Svg>
);

export const IconFilter = (props: IconProps) => (
  <Svg {...props}>
    <path d="M2.6 4h10.8M4.4 8h7.2M6.2 12h3.6" />
  </Svg>
);

export const IconCircle = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="8" cy="8" r="5.5" />
  </Svg>
);

export const IconHand = (props: IconProps) => (
  <Svg {...props}>
    <path d="M5.4 7.6V5.2a1 1 0 0 1 2 0v2.2M7.4 6.8V4.4a1 1 0 0 1 2 0v2.4M9.4 6.8V5a1 1 0 0 1 2 0v4.6a4 4 0 0 1-4 4h-.3a3.4 3.4 0 0 1-2.7-1.3L2.7 9.7a1.1 1.1 0 0 1 1.8-1.2l.9 1.1" />
  </Svg>
);

export const IconFolder = (props: IconProps) => (
  <Svg {...props}>
    <path d="M2.6 3.9h3.6l1.3 1.4h5.9v6.8H2.6V3.9Z" />
  </Svg>
);

export const IconSend = (props: IconProps) => (
  <Svg {...props}>
    <path d="M13.8 2.8 8.4 13.3 6.6 9.4 2.7 7.6l11.1-4.8Z" />
    <path d="m6.6 9.4 4.2-4.2" />
  </Svg>
);

export const IconRedo = (props: IconProps) => (
  <Svg {...props}>
    <path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8" />
    <path d="M2.6 2.8v3.4h3.4" />
  </Svg>
);

export const IconSource = (props: IconProps) => (
  <Svg {...props}>
    <path d="M9.2 2.6h4.2v4.2M13.2 2.8 7.6 8.4" />
    <path d="M12 9.4v3.6a.8.8 0 0 1-.8.8H3.4a.8.8 0 0 1-.8-.8V5.2a.8.8 0 0 1 .8-.8h3.4" />
  </Svg>
);

export const IconArrowDown = (props: IconProps) => (
  <Svg {...props}>
    <path d="M8 3v10M4.5 9.5 8 13l3.5-3.5" />
  </Svg>
);
