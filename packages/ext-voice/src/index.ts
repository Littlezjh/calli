import type { ExtensionManifest } from '@rah/extension-api';
import type { WebExtensionModule } from '@rah/extension-api/web';
import manifest from '../manifest.json';

const extension: WebExtensionModule = {
  manifest: manifest as ExtensionManifest,
  views: {},
};

export default extension;
