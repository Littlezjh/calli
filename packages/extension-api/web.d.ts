// Browser side of the contract: what a built-in extension's view receives from the host.
// Views import nothing from packages/web or packages/daemon; everything they need is on `WebHost`.
// Styling: only the variables at the top of packages/web/src/styles.css. No custom colours.

import type { ComponentType, ReactNode } from 'react';
import type { ExtensionManifest, HostIconName } from './manifest.js';
import type { WebHostMemory } from './memory.js';
import type { ThreadSummary } from './summary.js';

export type Locale = 'zh' | 'en' | 'ja';

/**
 * - `live`: the event stream is connected; summaries are current.
 * - `reconnecting`: the stream dropped and the host is retrying; show 「可能已过时」.
 * - `offline`: the hub cannot be reached, or this is the demo without a hub.
 */
export type ConnectionState = 'live' | 'reconnecting' | 'offline';

export interface AgentInfo {
  id: string;
  label: string;
  available: boolean;
}

export interface Unsubscribe {
  (): void;
}

export interface WebHostThreads {
  /** Current non-archived threads on the connected machine, team members excluded. */
  snapshot(): ThreadSummary[];
  /** Called with the full new list whenever any summary changes. Returns an unsubscribe function. */
  subscribe(listener: (threads: ThreadSummary[]) => void): Unsubscribe;
}

export interface WebHostConnection {
  state(): ConnectionState;
  /**
   * ISO time of the last successful thread list read, or null before the first one.
   * Null also covers the demo without a hub, where the host shows its own banner:
   * views warn 「可能已过时」 only when `state()` is not `live` and this is not null.
   */
  observedAt(): string | null;
  subscribe(listener: (state: ConnectionState) => void): Unsubscribe;
}

export interface WebHostStorage {
  /** Per device, namespaced to the extension. */
  get(key: string): string | null;
  set(key: string, value: string | null): void;
}

export interface PopoverProps {
  /** Accessible name of the panel. */
  label: string;
  trigger: ReactNode;
  triggerClassName?: string;
  triggerTitle?: string;
  align?: 'start' | 'end';
  children: (close: () => void) => ReactNode;
}

export interface PopoverOptionProps {
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}

/** Host components. They follow theme, density and phone layout like core screens. */
export interface WebHostUi {
  /** Markdown without raw HTML, external media or active links. */
  Markdown: ComponentType<{ text: string }>;
  Icon: ComponentType<{ name: HostIconName | 'pin' | 'clock' | 'worktree' | 'fork' | 'team' | 'check' | 'chevron' | 'close'; size?: number }>;
  /** The agent instance's mark and, with `label`, its name. */
  AgentMark: ComponentType<{ agentId: string; size?: number; label?: boolean }>;
  /** 「3 分钟前」 style text that updates itself. */
  RelativeTime: ComponentType<{ iso: string }>;
  /** Panel above the trigger on desktop, bottom sheet on phones. */
  Popover: ComponentType<PopoverProps>;
  /** A selectable row inside a Popover. */
  PopoverOption: ComponentType<PopoverOptionProps>;
  /** The host's empty-state illustration with one line of text. */
  EmptyState: ComponentType<{ text: string }>;
}

export interface WebHostNavigate {
  /** Leave the view and open the thread, as clicking it in the sidebar would. */
  openThread(threadId: string): void;
}

export interface WebHost {
  extensionId: string;
  threads: WebHostThreads;
  memory: WebHostMemory;
  connection: WebHostConnection;
  agents(): AgentInfo[];
  navigate: WebHostNavigate;
  locale(): Locale;
  storage: WebHostStorage;
  ui: WebHostUi;
  /** True on screens ≤ 640px wide; updates on resize through a re-render. */
  narrow: boolean;
}

export interface ExtensionViewProps {
  host: WebHost;
}

/** What a built-in extension's web entry exports as default. */
export interface WebExtensionModule {
  manifest: ExtensionManifest;
  /** Keyed by `ViewContribution.id`. */
  views: Record<string, ComponentType<ExtensionViewProps>>;
}
