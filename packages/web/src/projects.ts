import type { Thread } from './api';
import { folderName } from './paths';
import { projectDir } from './sidebar';

export interface ProjectOption {
  cwd: string;
  name: string;
  /** Known spellings of this directory, including its resolved path. */
  paths: string[];
}

export const projectPath = (path: string): string => path.replace(/\/+$/, '') || '/';

type ProjectThread = Pick<Thread, 'cwd' | 'cwdReal' | 'worktree' | 'scratch' | 'archivedAt' | 'updatedAt'>;

/** One machine's recent projects. Roots and drafts use the same identity as thread directories. */
export function buildProjectOptions(threads: ProjectThread[], roots: string[], draft: string): ProjectOption[] {
  const recent = threads.filter((t) => !t.scratch && !t.archivedAt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(projectDir);
  const aliases = new Map<string, string>();
  for (const dir of recent) {
    const spelling = projectPath(dir.cwd);
    if (!aliases.has(spelling)) aliases.set(spelling, projectPath(dir.real));
  }
  const projects = new Map<string, ProjectOption>();
  const push = (cwd: string, real = aliases.get(projectPath(cwd)) ?? cwd) => {
    if (!cwd) return;
    const key = projectPath(real);
    let option = projects.get(key);
    if (!option) {
      option = { cwd, name: folderName(cwd) || cwd, paths: [] };
      projects.set(key, option);
    }
    for (const path of [projectPath(cwd), key]) if (!option.paths.includes(path)) option.paths.push(path);
  };
  if (draft && !recent.some((dir) => projectPath(dir.cwd) === projectPath(draft))) push(draft);
  for (const dir of recent) push(dir.cwd);
  for (const root of roots) push(root);
  return [...projects.values()];
}
