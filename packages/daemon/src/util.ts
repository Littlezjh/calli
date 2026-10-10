import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/** True if argv[0] resolves to an executable: an absolute/relative path that exists, or a name on PATH. */
export function commandExists(bin: string): boolean {
  if (!bin) return false;
  if (bin.includes('/') || isAbsolute(bin)) {
    try {
      accessSync(bin, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  return dirs.some((dir) => existsSync(join(dir, bin)));
}

/** Concatenates the text parts of an agent content payload. Unknown shapes yield ''. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(textOf).join('');
  if (content && typeof content === 'object') {
    const c = content as { type?: string; text?: unknown; content?: unknown };
    if (typeof c.text === 'string') return c.text;
    if (c.content !== undefined) return textOf(c.content);
  }
  return '';
}
