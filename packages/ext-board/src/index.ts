import type { ExtensionManifest } from '@rah/extension-api';
import type { WebExtensionModule } from '@rah/extension-api/web';
import manifest from '../manifest.json';
import { BoardView } from './BoardView';
import './board.css';

const extension: WebExtensionModule = {
  manifest: manifest as ExtensionManifest,
  views: { board: BoardView },
};

export default extension;
