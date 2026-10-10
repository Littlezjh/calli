/** Last path segment, for showing a project name without the full path. */
export function folderName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

const withSlash = (root: string) => (root.endsWith('/') ? root : `${root}/`);

/**
 * A path as shown in the UI: relative to the thread's directory when it is inside it.
 * `roots` holds every spelling of that directory. Agents often report the resolved path,
 * which differs from the one the thread was created with when a symlink is involved.
 */
export function relativePath(path: string, roots: string[]): string {
  for (const root of roots) {
    if (!root || root === '/') continue;
    if (path === root) return '.';
    if (path.startsWith(withSlash(root))) return path.slice(withSlash(root).length);
  }
  return path;
}

/**
 * Removes the thread's directory from free text such as a tool title, so lines stay short.
 * Only at the start of a path: a directory name that merely appears inside a longer path is left alone.
 */
export function shortenPaths(text: string, roots: string[]): string {
  let out = text;
  // Longest first, so a root nested in another is not cut short by the outer one.
  const ordered = [...new Set(roots)].filter((r) => r && r !== '/').sort((a, b) => b.length - a.length);
  for (const root of ordered) {
    const escaped = withSlash(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(^|[\\s"'\`(=:,])${escaped}`, 'g'), '$1');
  }
  return out;
}

// The hub stores a message's pictures as <data dir>/attachments/<thread id>/<image id>.<ext>.
const ATTACHMENT_PATH = /(?:\/[^\s"'`]*)?\/attachments\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(?:png|jpg|gif|webp)/gi;

/** Replaces the paths of pictures the user sent with a name, where an agent mentions them (it opens them by path). */
export function nameAttachments(text: string): string {
  return text.replace(ATTACHMENT_PATH, '发送的图片');
}
