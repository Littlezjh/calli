import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { AgyAdapter, AGY_METADATA } from './adapters/agy.js';
import { ClaudeAcpAdapter, CLAUDE_METADATA } from './adapters/claude.js';
import { ZcodeAdapter, ZCODE_METADATA } from './adapters/zcode.js';
import { CodexAppServerAdapter, CODEX_METADATA } from './adapters/codex.js';
import { PiRpcAdapter, PI_METADATA } from './adapters/pi.js';
import { TraexAcpAdapter, TRAEX_METADATA } from './adapters/traex.js';
import type { AgentAdapter, DiscoveredAccount } from './adapters/types.js';
import { HttpError } from './errors.js';

/**
 * One configured agent instance: an adapter (how to talk to it) plus everything that makes this
 * instance its own, such as a second CLI binary or another account's environment. The adapter
 * implementations stay protocol-level; accounts are instances of them.
 */
export interface AgentInstance {
  /** What threads store; also the key in the adapter map. */
  id: string;
  adapter: 'claude' | 'pi' | 'agy' | 'traex' | 'codex' | 'zcode';
  label?: string;
  /** Full argv. Defaults to the adapter's own default command. */
  command?: string[];
  /** Merged over the daemon's environment for everything this instance spawns. */
  env?: Record<string, string>;
  /** The login this instance runs as, when it is a linked account (an email, for the picker). */
  account?: string;
}

interface InstanceFile {
  agents: AgentInstance[];
}

const ADAPTER_LABELS: Record<AgentInstance['adapter'], string> = {
  claude: 'Claude Code',
  pi: 'pi',
  agy: 'Antigravity',
  traex: 'TRAE CLI',
  codex: 'Codex',
  zcode: 'ZCode',
};

/** How each adapter is built. One line per protocol; instances differ only in command and env. */
function buildAdapter(
  instance: AgentInstance,
  /** Commands of the built-in instances: an instance without its own command inherits its adapter's. */
  defaults: Map<AgentInstance['adapter'], string[]>,
): AgentAdapter {
  const command = instance.command ?? defaults.get(instance.adapter) ?? [];
  const env = instance.env ?? {};
  let adapter: AgentAdapter;
  switch (instance.adapter) {
    case 'claude':
      adapter = new ClaudeAcpAdapter(command, env);
      break;
    case 'pi':
      adapter = new PiRpcAdapter(command, env);
      break;
    case 'agy':
      adapter = new AgyAdapter(command, env);
      break;
    case 'traex':
      adapter = new TraexAcpAdapter(command, env);
      break;
    case 'zcode':
      adapter = new ZcodeAdapter(command, env);
      break;
    case 'codex':
      adapter = new CodexAppServerAdapter(command, env);
      break;
  }
  // An instance may carry its own name ("Claude 工作号"); otherwise the adapter's own label stands.
  if (instance.label) (adapter as { label: string }).label = instance.label;
  return adapter;
}

/** The default instances when nothing is configured: one of each built-in agent. */
export function defaultInstances(opts: {
  claudeCommand: string[];
  piCommand: string[];
  agyCommand: string[];
  traexCommand: string[];
  codexCommand: string[];
  zcodeCommand?: string[];
}): AgentInstance[] {
  return [
    { id: 'claude', adapter: 'claude', command: opts.claudeCommand },
    { id: 'pi', adapter: 'pi', command: opts.piCommand },
    { id: 'agy', adapter: 'agy', command: opts.agyCommand },
    { id: 'traex', adapter: 'traex', command: opts.traexCommand },
    { id: 'codex', adapter: 'codex', command: opts.codexCommand },
    { id: 'zcode', adapter: 'zcode', command: opts.zcodeCommand ?? ['zcode', 'app-server'] },
  ];
}

export interface SupportedAgent {
  adapter: AgentInstance['adapter'];
  label: string;
  icon?: string;
  installGuide?: string;
}

export const SUPPORTED_AGENTS: SupportedAgent[] = [
  CLAUDE_METADATA,
  CODEX_METADATA,
  PI_METADATA,
  AGY_METADATA,
  TRAEX_METADATA,
  ZCODE_METADATA,
];

/** An executable on PATH that looks like another copy of a known agent CLI. */
export interface DiscoveredAgent {
  /** The proposed instance id: the executable's basename. */
  id: string;
  adapter: AgentInstance['adapter'];
  /** The absolute path found on PATH. */
  command: string;
  label?: string;
  icon?: string;
}

/** A signed-in account of a multi-account agent, shaped so the UI can link it in one click. */
export interface AccountToLink {
  adapter: AgentInstance['adapter'];
  email: string;
  /** Instance env built by the adapter (for Claude, the account's own CLAUDE_CONFIG_DIR). */
  env: Record<string, string>;
  /** Suggested instance id and label: the first free "claude-2", "Claude Code 2". */
  id: string;
  label: string;
}

/**
 * Basenames of CLIs the hub can already talk to. A name is the CLI itself or a numbered copy
 * (`agy2`, `claude-2`); lookalikes such as `ping`, `claude-agent-acp` and `traex-bridge` are left
 * alone. A suffix is a number, optionally after a separator, so an arbitrary word after a dash
 * does not turn another tool into a copy.
 */
const KNOWN_PREFIXES: Array<[AgentInstance['adapter'], RegExp]> = [
  ['claude', copyOf('claude')],
  ['pi', copyOf('pi')],
  ['agy', copyOf('agy')],
  ['codex', copyOf('codex')],
  ['zcode', copyOf('zcode')],
  // traex and the compatibility names its installer creates for the same CLI
  ['traex', copyOf('traex')],
  ['traex', copyOf('traecli')],
  ['traex', copyOf('trae-cli')],
  ['traex', copyOf('trae-agent')],
  ['traex', copyOf('coco')],
  ['traex', copyOf('ta')],
];

/** Aliases that share one executable: the adapter's own name wins when it is installed. */
const PREFERRED_NAMES: Record<AgentInstance['adapter'], string[]> = {
  claude: ['claude'],
  pi: ['pi'],
  agy: ['agy'],
  traex: ['traex', 'traecli', 'trae-cli', 'trae-agent', 'coco', 'ta'],
  codex: ['codex'],
  zcode: ['zcode'],
};

/**
 * Owns the agent instances: reads them from `agents.json` (or the built-in defaults), builds one
 * adapter per instance, and can find and add more CLIs later. The adapter map is live: adding an
 * instance makes it usable without a restart.
 */
export class AgentRegistry {
  readonly adapters = new Map<string, AgentAdapter>();
  private readonly instances = new Map<string, AgentInstance>();
  private readonly file: string | null;
  private readonly defaultCommands = new Map<AgentInstance['adapter'], string[]>();

  constructor(
    instances: AgentInstance[],
    /** Where `agents.json` lives, or null for a read-only registry (tests). */
    file: string | null,
  ) {
    for (const instance of instances) {
      // The first instance of an adapter decides what an instance without a command runs.
      if (!this.defaultCommands.has(instance.adapter) && instance.command) {
        this.defaultCommands.set(instance.adapter, instance.command);
      }
      this.register(instance);
    }
    this.file = file;
  }

  /** Builds a registry from the environment: `agents.json` in the data dir, or the defaults. */
  static fromEnv(opts: {
    dataDir: string;
    env: NodeJS.ProcessEnv;
    defaults: AgentInstance[];
  }): AgentRegistry {
    const file = join(opts.dataDir, 'agents.json');
    let instances: AgentInstance[] | null = null;
    const inline = opts.env.RAH_AGENTS_JSON;
    const source = inline ?? (existsSync(file) ? readFileSync(file, 'utf8') : null);
    if (source) {
      try {
        const parsed = JSON.parse(source) as InstanceFile;
        if (Array.isArray(parsed.agents)) instances = parsed.agents;
      } catch {
        // A broken file is reported, not fatal: the defaults keep the hub usable.
        console.warn('warning: agents.json is not valid JSON; using the built-in agents');
      }
    }
    return new AgentRegistry(instances ?? opts.defaults, inline ? null : file);
  }

  list(): AgentInstance[] {
    return [...this.instances.values()];
  }

  get(id: string): AgentInstance {
    const instance = this.instances.get(id);
    if (!instance) throw new HttpError(404, `unknown agent: ${id}`);
    return instance;
  }

  /** Renames an instance. Its id is what threads store, so it never changes. */
  async update(id: string, patch: { label?: unknown }): Promise<AgentInstance> {
    const instance = this.get(id);
    const label = typeof patch.label === 'string' ? patch.label.trim().slice(0, 60) : '';
    if (!label) throw new HttpError(400, 'a label is required');
    const next = { ...instance, label };
    await this.persist(this.list().map((i) => (i.id === id ? next : i)));
    this.instances.set(id, next);
    const adapter = this.adapters.get(id) as { label: string } | undefined;
    if (adapter) adapter.label = label;
    return next;
  }

  /** Removes only the hub's registration; the agent's own files and login are left alone. */
  async remove(id: string): Promise<AgentInstance> {
    const instance = this.get(id);
    await this.persist(this.list().filter((i) => i.id !== id));
    this.instances.delete(id);
    this.adapters.delete(id);
    return instance;
  }

  supported(): SupportedAgent[] {
    return [...SUPPORTED_AGENTS];
  }

  /**
   * Accounts of multi-account agents already signed in on this host that no instance uses yet.
   * Each adapter knows how to find its own (Claude: `~/.claude`-style directories); the registry
   * adds what only it knows — which accounts instances already claim, and which ids are free.
   */
  async discoverAccounts(): Promise<AccountToLink[]> {
    const home = process.env.HOME ?? homedir();
    const byAdapter = new Map<AgentInstance['adapter'], AgentInstance[]>();
    for (const instance of this.instances.values()) {
      const list = byAdapter.get(instance.adapter) ?? [];
      list.push(instance);
      byAdapter.set(instance.adapter, list);
    }
    const out: AccountToLink[] = [];
    // Suggested ids must not collide with real instances nor with each other within this scan.
    const takenIds = new Set(this.instances.keys());
    for (const [kind, instances] of byAdapter) {
      // The adapter of an instance that pins no account env of its own; it is the neutral one to ask.
      const neutral = instances.find((i) => !i.env || Object.keys(i.env).length === 0) ?? instances[0];
      const adapter = this.adapters.get(neutral.id);
      if (!adapter?.discoverAccounts) continue;
      // An account is claimed when an instance sets the same env, or when an env-less instance
      // exists and the account is the adapter's default one.
      const claimed = (account: DiscoveredAccount) =>
        instances.some(
          (i) =>
            Object.entries(i.env ?? {}).some(([k, v]) => account.env[k] === v) ||
            (!i.env || Object.keys(i.env).length === 0) && account.isDefault === true,
        );
      for (const account of await adapter.discoverAccounts(home)) {
        if (claimed(account)) continue;
        let n = 2;
        while (takenIds.has(`${kind}-${n}`)) n += 1;
        takenIds.add(`${kind}-${n}`);
        out.push({
          adapter: kind,
          email: account.email,
          env: account.env,
          id: `${kind}-${n}`,
          label: `${ADAPTER_LABELS[kind]} ${n}`,
        });
      }
    }
    return out.sort((a, b) => a.email.localeCompare(b.email));
  }

  private register(instance: AgentInstance): void {
    this.instances.set(instance.id, instance);
    this.adapters.set(instance.id, buildAdapter(instance, this.defaultCommands));
  }

  /** Adds an instance and persists it to `agents.json`. */
  async add(input: {
    id?: unknown;
    adapter?: unknown;
    label?: unknown;
    command?: unknown;
    env?: unknown;
    /** The login when this instance is a linked account (an email). */
    account?: unknown;
  }): Promise<AgentInstance> {
    const adapter = String(input.adapter ?? '');
    if (!(adapter in ADAPTER_LABELS)) throw new HttpError(400, `unknown adapter: ${adapter}`);
    const id = String(input.id ?? '').trim() || basenameOf(input.command);
    if (!id) throw new HttpError(400, 'an id or a command is required');
    if (!/^[\w.-]{1,40}$/.test(id)) throw new HttpError(400, 'ids are letters, digits, dash, dot and underscore, up to 40');
    if (this.instances.has(id)) throw new HttpError(409, `there already is an agent called ${id}`);
    const command = Array.isArray(input.command) && input.command.length
      ? input.command.map(String)
      : undefined;
    const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, 60) : undefined;
    const account =
      typeof input.account === 'string' && input.account.trim() ? input.account.trim().slice(0, 120) : undefined;
    const env =
      input.env && typeof input.env === 'object' && !Array.isArray(input.env)
        ? Object.fromEntries(Object.entries(input.env as Record<string, unknown>).map(([k, v]) => [String(k), String(v)]))
        : undefined;

    const instance: AgentInstance = {
      id,
      adapter: adapter as AgentInstance['adapter'],
      // Without a name it would inherit the adapter's own ("Antigravity"), which every copy of
      // that CLI would share. The id is what the user typed or what PATH had, so it reads better.
      label: label ?? id,
      ...(command ? { command } : {}),
      ...(env ? { env } : {}),
      ...(account ? { account } : {}),
    };
    this.register(instance);
    await this.persist();
    return instance;
  }

  private async persist(instances: AgentInstance[] = this.list()): Promise<void> {
    const file = this.file;
    if (!file) return;
    const body = JSON.stringify({ agents: instances }, null, 2) + '\n';
    const fs = await import('node:fs/promises');
    await fs.writeFile(file, body, 'utf8');
  }

  /**
   * Looks along PATH for executables that look like another copy of a known CLI (`agy2`, `claude2`).
   * Only basenames the hub can talk to are offered; the rest of PATH is ignored. Names that resolve
   * to the same executable are listed once, and an executable an instance already runs (including
   * through a path argument such as Claude's ACP bridge) is not offered again.
   */
  async discover(): Promise<DiscoveredAgent[]> {
    const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
    const taken = new Set(this.instances.keys());
    const takenPaths = new Set<string>();
    for (const instance of this.instances.values()) {
      const command = instance.command ?? this.defaultCommands.get(instance.adapter) ?? [];
      const base = basenameOf(command);
      if (base) taken.add(base);
      for (const [i, token] of command.entries()) {
        // The executable, and any path-like argument, may name the same program as a PATH entry.
        if (i > 0 && !token.includes('/') && !token.includes('\\')) continue;
        const path = resolveCommandPath(token, dirs);
        if (path) takenPaths.add(realPathOf(path));
      }
    }

    const found = new Map<string, DiscoveredAgent>(); // by real path: aliases collapse here
    const seen = new Set<string>();
    for (const dir of dirs) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue; // unreadable or gone
      }
      for (const name of names) {
        if (taken.has(name) || seen.has(name)) continue;
        const adapter = KNOWN_PREFIXES.find(([, re]) => re.test(name))?.[0];
        if (!adapter) continue;
        const full = join(dir, name);
        let realPath: string;
        try {
          if (!statSync(full).isFile()) continue;
          realPath = realpathSync(full);
        } catch {
          continue;
        }
        seen.add(name);
        if (takenPaths.has(realPath)) continue;
        const meta = SUPPORTED_AGENTS.find((s) => s.adapter === adapter);
        const candidate: DiscoveredAgent = {
          id: name,
          adapter,
          command: full,
          ...(meta?.label ? { label: meta.label } : {}),
          ...(meta?.icon ? { icon: meta.icon } : {}),
        };
        const previous = found.get(realPath);
        if (!previous || (previous.adapter === adapter && discoveryRank(adapter, name) < discoveryRank(adapter, previous.id))) {
          found.set(realPath, candidate);
        }
      }
    }
    return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}

function basenameOf(command: unknown): string {
  if (!Array.isArray(command) || command.length === 0) return '';
  const raw = String(command[0]);
  return raw.split(/[/\\]/).pop() ?? '';
}

/** `base` itself, or a numbered copy such as `agy2` or `claude-2`, never `ping` or `traex-bridge`. */
function copyOf(base: string): RegExp {
  return new RegExp(`^${escapeRegExp(base)}(?:$|[._-]?\\d)`);
}

/** Lower is a better name for a group of aliases: the adapter's own name, then compatibility names. */
function discoveryRank(adapter: AgentInstance['adapter'], name: string): number {
  if (name === adapter) return 0;
  if (isNumberedCopy(name, adapter)) return 1;
  const preferred = PREFERRED_NAMES[adapter];
  const exact = preferred.indexOf(name);
  if (exact >= 0) return 10 + exact;
  const alias = preferred.findIndex((base) => isNumberedCopy(name, base));
  return alias >= 0 ? 30 + alias : 100;
}

function isNumberedCopy(name: string, base: string): boolean {
  return name.length > base.length && copyOf(base).test(name);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Where a command token lives: an explicit path as given, or the first PATH directory with it. */
function resolveCommandPath(token: string, dirs: string[]): string | null {
  const candidates = isAbsolute(token) || token.includes('/') || token.includes('\\')
    ? [resolve(token)]
    : dirs.map((dir) => join(dir, token));
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

function realPathOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
