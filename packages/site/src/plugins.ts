import board from '../../ext-board/manifest.json';
import memory from '../../ext-memory/manifest.json';
import loopx from '../../ext-loopx/manifest.json';
import { zh as copy } from '../../web/src/i18n/locales/site/zh';

/** Only manifest metadata is imported; the website never starts or installs extensions. */
export const PLUGINS = [
  { id: board.id as 'board', title: copy.boardTitle, kind: copy.boardKind, description: copy.boardDescription, note: copy.boardNote },
  { id: memory.id as 'memory', title: copy.memoryTitle, kind: copy.memoryKind, description: copy.memoryDescription, note: copy.memoryNote },
  { id: loopx.id as 'loopx', title: copy.loopxTitle, kind: copy.loopxKind, description: copy.loopxDescription, note: copy.loopxNote },
];
