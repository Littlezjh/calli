import { readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { HttpError } from './errors.js';
import { isWithinWorkdirs } from './workdirs.js';

/** Folder names only: browsing candidates never grants access to files or creates a project root. */
export function listProjectDirectories(workdirs: string[], input?: string, home = homedir()) {
  if (input && !isAbsolute(input)) throw new HttpError(400, 'give an absolute path');
  const path = resolve(input || home);
  const bounds = [home, ...workdirs];
  if (!isWithinWorkdirs(path, bounds)) throw new HttpError(403, 'path is outside project browsing roots');
  try {
    if (!statSync(path).isDirectory()) throw new HttpError(404, 'directory not found');
    const directories = readdirSync(path, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .filter((entry) => {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) return false;
        const child = join(path, entry.name);
        try {
          return isWithinWorkdirs(child, bounds) && statSync(child).isDirectory();
        } catch {
          return false;
        }
      })
      .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = dirname(path);
    const allowed = isWithinWorkdirs(path, workdirs);
    const target = realpathSync(path);
    return {
      path,
      parent: parent !== path && isWithinWorkdirs(parent, bounds) ? parent : null,
      directories,
      allowed,
      selectable: allowed || (target !== sep && target !== realpathSync(home)),
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') throw new HttpError(403, 'directory is not readable');
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new HttpError(404, 'directory not found');
    throw error;
  }
}
