import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TodoNote, TodoRecord } from './store.js';

/**
 * File mirror of the plan page's todos inside the personal directory (step 1 of
 * docs/personal-files-design.md). The database stays the source of truth: every add, change,
 * note write and removal also lands as `matters/<id>-<slug>/matter.md`, and a startup
 * `syncAll` reconciles the whole tree. Git keeps local file history (no remote), but only for
 * a repository Calli initialized itself — proven by the .calli/git-owned marker; a directory
 * inside someone else's worktree is never initialized and never committed, and the add is
 * scoped to Calli's own paths. Nothing here may break the API: every failure is logged and
 * swallowed.
 */

/** Commits as Calli no matter how git is configured on the machine; never signs. */
const GIT_IDENTITY = ['-c', 'user.name=Calli', '-c', 'user.email=calli@localhost', '-c', 'commit.gpgsign=false'];

/** The only paths a commit may touch; extend when inbox/journal and friends arrive. */
const OWNED_PATHS = ['matters', 'AGENTS.md', 'profile.md', '.gitignore'];

/** Marks a repository Calli initialized itself; lives in the gitignored .calli/. */
const OWNERSHIP_MARKER = '.calli/git-owned';

const GITIGNORE = '.calli/\n.matter.md.tmp\n';

const AGENTS_MD = `# Personal directory

This is the person's private Calli directory. \`matters/\` holds one folder per matter: the
plan page's items, mirrored here by Calli from its database. The directory is a local git
repository for history; there is no remote.

For agents:

- Read freely. A matter's state is in its \`matter.md\` frontmatter, its continuation note in
  the body.
- Change matters only through the \`calli todo\` command (see \`calli todo --help\`). Never
  edit files under \`matters/\` by hand: Calli overwrites them from its database, and hand
  edits are lost.
- \`profile.md\` is the person's own notes; do not rewrite it unless asked.

说明（中文）：这是 Calli 为人维护的私人目录；\`matters/\` 下的内容由 Calli 从数据库镜像生成。
事项只能用 \`calli todo\` 命令修改，不要直接改 \`matters/\` 里的文件；\`profile.md\` 由人自己写。
`;

const PROFILE_MD = `# 我的说明

这里由我自己写，Calli 和各家 agent 都会读，用来了解我怎么工作。

## 我在意什么

## 老板和 PM

## 周报节奏

## 信息源
`;

/** Shown for a matter whose note was never written, so the file shows what belongs where. */
const MATTER_SCAFFOLD = '## 欠谁什么\n## 定了什么\n## 做到哪\n## 下一步\n';

/** One todo as the mirror needs it: the record, its note, its linked thread IDs. */
export interface MatterInput { todo: TodoRecord; note: TodoNote; threads: string[] }

/** A path-safe slug from a title: letters and numbers (any script) kept, one dash per run. */
export function matterSlug(title: string): string {
  const slug = [...title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/gu, '')].slice(0, 40).join('').replace(/-+$/u, '');
  return slug || 'matter';
}

const yamlString = (value: string): string => JSON.stringify(value);
const yamlValue = (value: string | null): string => (value === null ? 'null' : yamlString(value));

/** matter.md with the design's frontmatter; the body is the continuation note, verbatim. */
function matterMarkdown(todo: TodoRecord, note: TodoNote, threads: string[]): string {
  // Done stays done; an explicit lane wins; without one, waiting maps to wait and the rest to
  // doing. The spec's you/later lanes and its `who` field are covered by the todo's lane field.
  const lane = todo.done || todo.state === 'done' ? 'done' : todo.lane ?? (todo.state === 'waiting' ? 'wait' : 'doing');
  const yaml = [
    `id: ${yamlString(todo.id)}`,
    `title: ${yamlString(todo.text)}`,
    `lane: ${lane}`,
    `owner: ${todo.owner}`,
    `due: ${yamlValue(todo.dueAt)}`,
    `follow_up: ${yamlValue(todo.followUpAt)}`,
    `waiting_on: ${yamlValue(todo.waitingOn)}`,
    `rev: ${todo.rev}`,
    `created: ${yamlValue(todo.createdAt)}`,
    `updated: ${yamlValue(note.updatedAt)}`,
    `threads: [${threads.map(yamlString).join(', ')}]`,
  ].join('\n');
  const body = note.text.trim() ? note.text : MATTER_SCAFFOLD;
  return `---\n${yaml}\n---\n${body.endsWith('\n') ? body : `${body}\n`}`;
}

export class PersonalFiles {
  /** The directory prepare() last set up, so repeated writes skip the checks. */
  private preparedFor: string | null = null;
  /** False once git itself proved unavailable (no binary, init failed); file writes continue. */
  private gitUsable = true;
  /** True only for a repository Calli initialized itself, proven by the ownership marker. */
  private gitOwned = false;
  /** The foreign-repository notice is logged once per instance, not per write. */
  private foreignLogged = false;
  /** Writes run one at a time: git cannot take two index updates at once. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly root: string | (() => string)) {}

  private dir(): string { return typeof this.root === 'string' ? this.root : this.root(); }

  /** One job after another; a failure is logged here and never reaches the caller. */
  private run(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work).catch(error => this.log('mirror step failed', error));
    this.queue = next;
    return next;
  }

  /** Waits for everything queued so far, and for anything that arrives while waiting. */
  async dispose(): Promise<void> {
    const last = this.queue;
    await last;
    if (this.queue !== last) return this.dispose();
  }

  /** Creates the skeleton on first use. Existing files are never overwritten. */
  ensure(): Promise<void> {
    return this.run(async () => {
      const root = this.dir();
      if (this.preparedFor !== root) { await this.prepare(root); this.preparedFor = root; }
    });
  }

  writeMatter(todo: TodoRecord, note: TodoNote, threads: string[] = []): Promise<void> {
    return this.run(async () => {
      try {
        const root = this.dir();
        if (this.preparedFor !== root) { await this.prepare(root); this.preparedFor = root; }
        await this.writeInto(join(root, 'matters'), todo, note, threads);
      } catch (error) { this.log(`cannot mirror matter ${todo.id}`, error); }
    });
  }

  removeMatter(id: string): Promise<void> {
    return this.run(async () => {
      try {
        const matters = join(this.dir(), 'matters');
        const dir = this.matterDir(matters, id);
        if (!dir) return;
        // Deleted outright, not parked in a trash folder: the database is the authority and git
        // history preserves the file, so trash would only add untracked clutter that a later
        // index rebuild (step 3 of the design) would have to skip.
        rmSync(dir, { recursive: true, force: true });
        await this.commit(`matter delete ${id}`);
      } catch (error) { this.log(`cannot remove mirrored matter ${id}`, error); }
    });
  }

  /** Startup reconciliation: everything the database has is written, everything it has not is removed. */
  syncAll(todos: MatterInput[]): Promise<void> {
    return this.run(async () => {
      try {
        const root = this.dir();
        if (this.preparedFor !== root) { await this.prepare(root); this.preparedFor = root; }
        const matters = join(root, 'matters');
        const keep = new Map<string, string>();
        for (const { todo, note, threads } of todos) {
          await this.writeInto(matters, todo, note, threads);
          keep.set(todo.id, `${todo.id}-${matterSlug(todo.text)}`);
        }
        for (const name of this.listMatters(matters)) {
          const id = this.frontmatterId(join(matters, name));
          // Directories the database does not know go away, as do duplicates left under an old
          // title. An unreadable directory is not proven to be a mirror, so it stays.
          if (id && keep.get(id) !== name) {
            rmSync(join(matters, name), { recursive: true, force: true });
            await this.commit(`matter delete ${id}`);
          }
        }
      } catch (error) { this.log('cannot sync the matter mirror', error); }
    });
  }

  /** Writes one matter.md; renames the directory first when the title moved it. */
  private async writeInto(matters: string, todo: TodoRecord, note: TodoNote, threads: string[]): Promise<void> {
    const target = join(matters, `${todo.id}-${matterSlug(todo.text)}`);
    const current = this.matterDir(matters, todo.id);
    if (current && current !== target) {
      // The title changed: the directory is renamed, nothing stays under the old name.
      rmSync(target, { recursive: true, force: true });
      renameSync(current, target);
    }
    mkdirSync(target, { recursive: true });
    // Write a temporary file and rename, so a crash mid-write cannot leave a torn matter.md.
    const tmp = join(target, '.matter.md.tmp');
    writeFileSync(tmp, matterMarkdown(todo, note, threads));
    renameSync(tmp, join(target, 'matter.md'));
    await this.commit(`matter update ${todo.id}`);
  }

  private async prepare(root: string): Promise<void> {
    mkdirSync(root, { recursive: true });
    mkdirSync(join(root, 'matters'), { recursive: true });
    await this.claimRepository(root);
    for (const [name, content] of [['.gitignore', GITIGNORE], ['AGENTS.md', AGENTS_MD], ['profile.md', PROFILE_MD]] as const) {
      const path = join(root, name);
      if (existsSync(path)) continue;
      try { writeFileSync(path, content); } catch (error) { this.log(`cannot write ${name}`, error); }
    }
    await this.commit('init personal directory');
  }

  /**
   * Only a repository Calli initialized itself is ever committed to: the marker in the
   * gitignored .calli/ proves it. A directory inside someone else's worktree is neither
   * initialized nor committed — the person's unrelated work must not be swept into Calli's
   * commits under Calli's name.
   */
  private async claimRepository(root: string): Promise<void> {
    const real = (path: string) => { try { return realpathSync(path); } catch { return path; } };
    let toplevel: string | null = null;
    try { toplevel = (await this.git(['rev-parse', '--show-toplevel'])).trim() || null; }
    catch { toplevel = null; }
    if (toplevel) {
      this.gitOwned = real(toplevel) === real(root) && existsSync(join(root, OWNERSHIP_MARKER));
      if (!this.gitOwned && !this.foreignLogged) {
        this.foreignLogged = true;
        this.log(`git repository at ${toplevel} was not created by Calli; mirror files are written but never committed`, '' );
      }
      return;
    }
    try {
      await this.git(['init', '--quiet']);
      mkdirSync(join(root, '.calli'), { recursive: true });
      writeFileSync(join(root, OWNERSHIP_MARKER), '');
      this.gitOwned = true;
    } catch (error) {
      this.gitUsable = false;
      this.gitOwned = false;
      this.log('git init failed', error);
    }
  }

  /** The directory a matter currently lives in, under whatever slug it was first written. */
  private matterDir(matters: string, id: string): string | null {
    const found = this.listMatters(matters).filter(name => name === id || name.startsWith(`${id}-`)).sort();
    return found.length ? join(matters, found[0]) : null;
  }

  private listMatters(matters: string): string[] {
    try {
      return readdirSync(matters).filter(name => !name.startsWith('.') && statSync(join(matters, name)).isDirectory());
    } catch { return []; }
  }

  /** Reads a directory's matter id out of its frontmatter; null when the file is not a mirror. */
  private frontmatterId(dir: string): string | null {
    try {
      const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(dir, 'matter.md'), 'utf8'));
      const line = match?.[1].split(/\r?\n/).find(candidate => candidate.startsWith('id:'));
      if (!line) return null;
      const value = line.slice(3).trim();
      return /^".*"$/s.test(value) ? JSON.parse(value) as string : value;
    } catch { return null; }
  }

  /** Commits Calli's own paths, as Calli. An unowned repository, an empty tree and a broken git
   *  are all skipped or logged, never raised. */
  private async commit(message: string): Promise<void> {
    if (!this.gitUsable || !this.gitOwned) return;
    try {
      const status = await this.git(['status', '--porcelain', '--', ...OWNED_PATHS]);
      if (!status.trim()) return;
      await this.git(['add', '-A', '--', ...OWNED_PATHS]);
      await this.git([...GIT_IDENTITY, 'commit', '--quiet', '-m', message]);
    } catch (error) { this.log('git commit failed', error); }
  }

  /** Only execFile, never a shell: titles and notes reach git as plain arguments. */
  private git(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd: this.dir() }, (error, stdout, stderr) => {
        if (error) reject(new Error(`git ${args[0]} failed: ${(stderr || error.message).trim().split('\n').slice(-1)[0]}`));
        else resolve(stdout);
      });
    });
  }

  private log(message: string, error: unknown): void {
    console.error(`[personal-files] ${message}${error ? `: ${error instanceof Error ? error.message : error}` : ''}`);
  }
}
