/** How threads are arranged in the sidebar. Pure, so it can be tested directly. */
import type { AgentInfo, Section, Thread } from './api';
import { folderName } from './paths';

/**
 * Which agents need their name next to their mark: a mark several agents share is only
 * ambiguous for the agents after its first one, which is the original built-in.
 */
export function taggedAgents(agents: Array<Pick<AgentInfo, 'icon'> & { id?: string }>): Set<string> {
  const firstWithIcon = new Map<string, string>();
  const tagged = new Set<string>();
  for (const { id, icon } of agents) {
    if (!icon) continue;
    const first = firstWithIcon.get(icon);
    if (first === undefined) firstWithIcon.set(icon, id ?? '');
    else if (id && id !== first) tagged.add(id);
  }
  return tagged;
}

/**
 * The directory a thread counts under. A fork in a git worktree stands in a directory of its own,
 * but it is still work on the project it was forked in, so that is where it is listed.
 */
export function projectDir(t: Pick<Thread, 'cwd' | 'cwdReal' | 'worktree'>): { cwd: string; real: string } {
  return t.worktree ? { cwd: t.worktree.of, real: t.worktree.ofReal || t.worktree.of } : { cwd: t.cwd, real: t.cwdReal || t.cwd };
}

export interface SidebarModel {
  pinned: Thread[];
  sections: Array<{ section: Section; threads: Thread[] }>;
  /** `key` identifies the project (and its collapsed state); `cwd` is the path to show. */
  projects: Array<{ key: string; cwd: string; name: string; threads: Thread[] }>;
  /** Number of threads shown after filtering. */
  count: number;
}

/**
 * A thread appears exactly once: under "pinned" if pinned, else under its section if it has one,
 * else under its project (working directory). Threads keep the order they arrive in.
 *
 * Projects are told apart by the directory with symlinks resolved: the same folder reached by two
 * spellings is one project. The group shows the spelling of its most recent thread.
 */
export function buildSidebar(threads: Thread[], sections: Section[], search: string): SidebarModel {
  const query = search.trim().toLowerCase();
  const visible = query
    ? threads.filter((t) => t.title.toLowerCase().includes(query) || t.cwd.toLowerCase().includes(query))
    : threads;

  const sectionIds = new Set(sections.map((s) => s.id));
  const pinned: Thread[] = [];
  const bySection = new Map<string, Thread[]>();
  const byProject = new Map<string, Thread[]>();

  for (const t of visible) {
    if (t.pinned) {
      pinned.push(t);
    } else if (t.sectionId && sectionIds.has(t.sectionId)) {
      bySection.set(t.sectionId, [...(bySection.get(t.sectionId) ?? []), t]);
    } else {
      const key = projectDir(t).real;
      byProject.set(key, [...(byProject.get(key) ?? []), t]);
    }
  }

  return {
    pinned,
    // While searching, empty sections are noise. Otherwise they stay visible so threads can be filed into them.
    sections: [...sections]
      .sort((a, b) => a.position - b.position)
      .map((section) => ({ section, threads: bySection.get(section.id) ?? [] }))
      .filter((s) => !query || s.threads.length > 0),
    // Projects follow their most recent thread, which is first in each list.
    projects: [...byProject.entries()]
      .map(([key, list]) => ({ key, cwd: projectDir(list[0]).cwd, name: folderName(projectDir(list[0]).cwd), threads: list }))
      .sort((a, b) => (a.threads[0].updatedAt < b.threads[0].updatedAt ? 1 : -1)),
    count: visible.length,
  };
}
