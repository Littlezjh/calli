import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/** The path with symlinks resolved, or just normalised when it does not exist. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * True when `dir` is one of the allowed working directories or lies inside one.
 * Symlinks are resolved first, so a link inside an allowed directory cannot lead out of it.
 */
export function isWithinWorkdirs(dir: string, workdirs: string[]): boolean {
  const target = real(dir);
  return workdirs.some((w) => {
    const root = real(w);
    return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
  });
}
