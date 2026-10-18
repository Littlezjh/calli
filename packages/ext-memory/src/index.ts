import type { ExtensionManifest } from '@rah/extension-api';
import type { WebExtensionModule } from '@rah/extension-api/web';
import manifest from '../manifest.json';
import { MemoryView } from './MemoryView';
import './memory.css';

const extension: WebExtensionModule = { manifest: manifest as ExtensionManifest, views: { memory: MemoryView } };
export default extension;
