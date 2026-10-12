import type { ReactNode } from 'react';

interface IconProps {
  size?: number;
  children: ReactNode;
}

function Svg({ size = 18, children }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

/** An agent's own mark, drawn from the path its adapter sends. Filled, unlike the line icons below. */
export const AgentMark = ({ path, size = 16 }: { path: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" aria-hidden="true">
    <path d={path} />
  </svg>
);

export const IconMenu = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h10" />
  </Svg>
);
export const IconPlus = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const IconSend = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Svg>
);
export const IconStop = (p: { size?: number }) => (
  <Svg {...p}>
    <rect x="7" y="7" width="10" height="10" rx="2" />
  </Svg>
);
export const IconChevron = (p: { size?: number; open?: boolean }) => (
  <Svg {...p}>
    <path d={p.open ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'} />
  </Svg>
);
export const IconTerminal = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M5 7l4 4-4 4M12 17h7" />
  </Svg>
);
export const IconFile = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M7 3h7l5 5v13H7zM14 3v5h5" />
  </Svg>
);
export const IconSearch = (p: { size?: number }) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6" />
    <path d="M20 20l-4.5-4.5" />
  </Svg>
);
export const IconEdit = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" />
  </Svg>
);
export const IconFolder = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M3 6h6l2 2h10v11H3z" />
  </Svg>
);
export const IconShield = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z" />
  </Svg>
);
export const IconShieldAlert = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z" />
    <path d="M12 8.5v4M12 15.5v.01" />
  </Svg>
);
export const IconHand = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M8 12V6.5a1.5 1.5 0 013 0V11M11 11V5a1.5 1.5 0 013 0v6M14 11V6.5a1.5 1.5 0 013 0V14a6 6 0 01-6 6h-.5a5 5 0 01-4.2-2.3L4.6 14a1.4 1.4 0 012.3-1.6L8 13.6" />
  </Svg>
);
export const IconCheck = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Svg>
);
export const IconPin = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7" />
  </Svg>
);
export const IconClose = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);
export const IconRefresh = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M19 12a7 7 0 1 1-2-4.9M17 3v4.3h-4.3" />
  </Svg>
);
export const IconBolt = (p: { size?: number }) => (
  <Svg {...p}><path d="m13 2-9 12h7l-1 8 10-12h-7z" /></Svg>
);
export const IconCompress = (p: { size?: number }) => (
  <Svg {...p}><path d="m5 3 7 7 7-7M5 21l7-7 7 7M4 12h16" /></Svg>
);
export const IconExternal = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M14 5h5v5M19 5l-7 7M17 14v5H5V7h5" />
  </Svg>
);
export const IconGauge = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M4 14a8 8 0 1 1 16 0M12 14l4-4" />
  </Svg>
);
export const IconArchive = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M4 5h16v4H4zM6 9v10h12V9M10 13h4" />
  </Svg>
);
export const IconTrash = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6" />
  </Svg>
);
export const IconCopy = (p: { size?: number }) => (
  <Svg {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2.5" />
    <path d="M5.5 15H5a1 1 0 01-1-1V5a1 1 0 011-1h9a1 1 0 011 1v.5" />
  </Svg>
);
export const IconFork = (p: { size?: number }) => (
  <Svg {...p}>
    <circle cx="7" cy="5.5" r="2" />
    <circle cx="7" cy="18.5" r="2" />
    <circle cx="17" cy="8.5" r="2" />
    <path d="M7 7.5v9M17 10.5c0 3-3.5 3.5-10 4" />
  </Svg>
);
export const IconImport = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M12 4v10M8 10.5l4 4 4-4M5 15v3.5A1.5 1.5 0 006.5 20h11a1.5 1.5 0 001.5-1.5V15" />
  </Svg>
);
export const IconInfo = (p: { size?: number }) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5M12 7.8v.01" />
  </Svg>
);
export const IconHelp = (p: { size?: number }) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M9.6 9.5a2.5 2.5 0 014.8 1c0 1.7-2.4 2-2.4 3.5M12 16.8v.01" />
  </Svg>
);
export const IconDot = (p: { size?: number }) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="8" />
  </Svg>
);
export const IconPaperclip = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M19 11.5l-7.2 7.2a4.5 4.5 0 01-6.4-6.4l7.6-7.6a3 3 0 014.3 4.3l-7.5 7.5a1.5 1.5 0 01-2.2-2.1l6.9-6.9" />
  </Svg>
);
export const IconArrowDown = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </Svg>
);
export const IconMore = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth={2.6} />
  </Svg>
);
/** Six dots: the handle a row is dragged by. */
export const IconGrip = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" strokeWidth={2.6} />
  </Svg>
);
export const IconArrowUp = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Svg>
);
export const IconList = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01" />
  </Svg>
);
export const IconSparkle = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M12 4l1.8 4.7L18.5 10.5l-4.7 1.8L12 17l-1.8-4.7L5.5 10.5l4.7-1.8zM18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
  </Svg>
);
export const IconRestore = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M4 8v5h5M4.6 13a8 8 0 101.9-6.2L4 9" />
  </Svg>
);
export const IconCube = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9" />
  </Svg>
);
export const IconSlash = (p: { size?: number }) => (
  <Svg {...p}>
    <rect x="4" y="4" width="16" height="16" rx="4" />
    <path d="M10 16l4-8" />
  </Svg>
);
export const IconGlobe = (p: { size?: number }) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.6 2.4 3.9 5.2 3.9 8.5s-1.3 6.1-3.9 8.5c-2.6-2.4-3.9-5.2-3.9-8.5s1.3-6.1 3.9-8.5z" />
  </Svg>
);
export const IconComputer = (p: { size?: number }) => (
  <Svg {...p}>
    <rect x="4" y="4" width="16" height="12" rx="2" />
    <path d="M4 16l-2 4h20l-2-4M9 20h6" />
  </Svg>
);
/** A machine: two units in a rack. */
export const IconServer = (p: { size?: number }) => (
  <Svg {...p}>
    <rect x="4" y="4.5" width="16" height="6.5" rx="2" />
    <rect x="4" y="13" width="16" height="6.5" rx="2" />
    <path d="M7.6 7.75h.01M7.6 16.25h.01" />
  </Svg>
);
export const IconSettings = (p: { size?: number }) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3.5l1.6 2.3 2.7-.6.8 2.7 2.6 1-1 2.6 1 2.6-2.6 1-.8 2.7-2.7-.6L12 20.5l-1.6-2.3-2.7.6-.8-2.7-2.6-1 1-2.6-1-2.6 2.6-1 .8-2.7 2.7.6z" />
  </Svg>
);
/** A git worktree: the fork's branch, ending in a checkout of its own. */
export const IconWorktree = (p: { size?: number }) => (
  <Svg {...p}>
    <circle cx="6.5" cy="5.5" r="2" />
    <circle cx="6.5" cy="18.5" r="2" />
    <path d="M6.5 7.5v9M6.5 14.5c7 0 10-1 10-4" />
    <rect x="12.5" y="3.5" width="8" height="7" rx="1.6" />
  </Svg>
);
export const IconPalette = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M12 3.5a8.5 8.5 0 000 17c1 0 1.7-.8 1.7-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.4-.7-.4-1.1 0-.9.7-1.7 1.7-1.7h1.9a4.1 4.1 0 004.1-4.2c0-3.9-3.8-7.1-8.5-7.1z" />
    <path d="M8 9.6h.01M11.6 7.4h.01M15.6 8.8h.01M7.6 13.6h.01" />
  </Svg>
);
export const IconSignOut = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M10 4H6a2 2 0 00-2 2v12a2 2 0 002 2h4M15 8l4 4-4 4M19 12H9" />
  </Svg>
);
export const IconQuote = (p: { size?: number }) => (
  <svg width={p.size ?? 18} height={p.size ?? 18} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M10.6 6.2c-3.1 1.6-4.7 4.2-4.7 7.6 0 2.3 1.1 3.9 2.9 3.9 1.5 0 2.6-1.1 2.6-2.5 0-1.4-.9-2.4-2.2-2.4-.2 0-.4 0-.5.1.2-1.7 1.3-3 3-4zM19.6 6.2c-3.1 1.6-4.7 4.2-4.7 7.6 0 2.3 1.1 3.9 2.9 3.9 1.5 0 2.6-1.1 2.6-2.5 0-1.4-.9-2.4-2.2-2.4-.2 0-.4 0-.5.1.2-1.7 1.3-3 3-4z" />
  </svg>
);
export const IconSideChat = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M13.5 5H7a3 3 0 00-3 3v6a3 3 0 003 3h1v3l3.5-3h2" />
    <path d="M13 3h4a3 3 0 013 3v5a3 3 0 01-3 3h-1" />
  </Svg>
);
/** A window with its side panel: shows or hides the thread list. */
export const IconSidebar = (p: { size?: number }) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="3.5" />
    <path d="M9.5 4.5v15" />
  </Svg>
);
/** What is going on across the threads: the list by activity. */
export const IconBell = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M6.5 16.5v-5.6a5.5 5.5 0 0111 0v5.6l1.5 1.5H5z" />
    <path d="M10 20.5a2.2 2.2 0 004 0" />
  </Svg>
);
export const IconMinus = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M5 12h14" />
  </Svg>
);
/** Save to this device. */
export const IconDownload = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14" />
  </Svg>
);
/** Long lines folded onto the next row. */
export const IconWrap = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M4 6h16M4 12h13a3 3 0 010 6h-5M14 15.5L11.5 18l2.5 2.5M4 18h4" />
  </Svg>
);
/** The thread's files: a folder with a page in front. */
export const IconFiles = (p: { size?: number }) => (
  <Svg {...p}>
    <path d="M3 18V5h5l2 2h7v2" />
    <path d="M9 11h12v9H9z" />
  </Svg>
);

export const IconAgents = (p: { size?: number }) => (
  <Svg {...p}><circle cx="9" cy="7" r="3" /><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 4a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v2" /></Svg>
);
