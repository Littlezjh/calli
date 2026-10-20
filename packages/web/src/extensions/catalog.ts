/**
 * The browser code of the extensions that ship with Limi. Each loads as a chunk of its own the
 * first time one of its views opens, so a page that never shows one never downloads it. Extension
 * packages depend on @rah/extension-api only; nothing here is visible to them but `WebHost`.
 */
import type { ExtensionManifest } from '@rah/extension-api';
import type { WebExtensionModule } from '@rah/extension-api/web';
import memoryManifest from '@rah/ext-memory/manifest.json';
import boardManifest from '@rah/ext-board/manifest.json';
import voiceManifest from '@rah/ext-voice/manifest.json';

export const BUILTIN_MODULES: Record<string, () => Promise<{ default: WebExtensionModule }>> = {
  board: () => import('@rah/ext-board'),
  memory: () => import('@rah/ext-memory'),
  voice: () => import('@rah/ext-voice'),
};

/** The same extensions' manifests, for the demo: it has no daemon to read the catalog from. */
export const BUILTIN_MANIFESTS: ExtensionManifest[] = [
  boardManifest as ExtensionManifest,
  memoryManifest as ExtensionManifest,
  voiceManifest as ExtensionManifest,
];
