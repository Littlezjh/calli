// Extension manifest: what an extension is, what it asks for and where it shows up.
// The host reads it before running any extension code, and shows the permissions at install time.

import type { Permission } from './permissions.js';
import type { NotificationHook, RequestHook } from './hooks.js';

/** Contract version. Within one major version fields are only added, never changed. */
export type ApiVersion = 1;

/** Text in every interface language. `zh` is the source language. */
export interface LocalizedText {
  zh: string;
  en: string;
  ja: string;
}

/**
 * Icons the host can draw. Extensions name an icon instead of shipping SVG,
 * so every entry looks like the rest of the interface.
 */
export type HostIconName =
  | 'board'
  | 'list'
  | 'activity'
  | 'clock'
  | 'target'
  | 'gauge'
  | 'sparkle'
  | 'cube'
  | 'globe'
  | 'server'
  | 'bolt';

/** A main-area page contributed by an extension. */
export interface ViewContribution {
  /** Unique within the extension. The default route is `#/ext/<extension id>/<view id>`. */
  id: string;
  title: LocalizedText;
  icon: HostIconName;
  /**
   * Short route alias, e.g. `#/board`. Must start with `#/` and must not clash with core routes
   * (`#/todos`, `#/schedules`, `#/activity`, `#/skills`, `#/mcp`, `#/extensions`).
   */
  route?: `#/${string}`;
  /** Show an entry in the sidebar next to 计划 and 定时任务. `pinned` is the default; the user can change it. */
  sidebar?: { pinned: boolean };
}

export interface Contributions {
  views?: ViewContribution[];
}

/** Where the code comes from. v1 only has extensions that ship with Limi. */
export type ExtensionSource = 'builtin';

export interface ExtensionManifest {
  /** Lowercase letters, digits and `-`. Stable across versions. */
  id: string;
  /** Semver of the extension itself. */
  version: string;
  apiVersion: ApiVersion;
  name: LocalizedText;
  description: LocalizedText;
  /** Everything the extension may use. Shown at install; new permissions on upgrade need a new confirmation. */
  permissions: Permission[];
  contributes: Contributions;
  /** Notifications the extension wants. It receives nothing it did not declare. Empty for view-only extensions. */
  subscribes?: NotificationHook[];
  /** Requests the extension answers. Planned; v1 hosts ignore it. */
  answers?: RequestHook[];
}

/** One row of `GET /api/extensions`: the catalog entry plus its state on this machine. */
export interface ExtensionState {
  manifest: ExtensionManifest;
  source: ExtensionSource;
  installed: boolean;
  /** Installed and switched on. A disabled extension keeps its grant but shows nothing. */
  enabled: boolean;
  /** Permissions the user confirmed. Equal to `manifest.permissions` once installed. */
  granted: Permission[];
  installedAt: string | null;
  updatedAt: string | null;
}
