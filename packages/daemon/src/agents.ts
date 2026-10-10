import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { delimiter } from 'node:path';
import { AgyAdapter } from './adapters/agy.js';
import { ClaudeAcpAdapter } from './adapters/claude.js';
import { PiRpcAdapter } from './adapters/pi.js';
import { TraexAcpAdapter } from './adapters/traex.js';
import type { AgentAdapter } from './adapters/types.js';
import { HttpError } from './errors.js';

/**
 * One configured agent instance: an adapter (how to talk to it) plus everything that makes this
 * instance its own, such as a second CLI binary or another account's environment. The adapter
 * implementations stay protocol-level; accounts are instances of them.
 */
export interface AgentInstance {
  /** What threads store; also the key in the adapter map. */
  id: string;
  adapter: 'claude' | 'pi' | 'agy' | 'traex';
  label?: string;
  /** Full argv. Defaults to the adapter's own default command. */
  command?: string[];
  /** Merged over the daemon's environment for everything this instance spawns. */
  env?: Record<string, string>;
}

interface InstanceFile {
  agents: AgentInstance[];
}

const ADAPTER_LABELS: Record<AgentInstance['adapter'], string> = {
  claude: 'Claude Code',
  pi: 'pi',
  agy: 'Antigravity',
  traex: 'TRAE CLI',
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
}): AgentInstance[] {
  return [
    { id: 'claude', adapter: 'claude', command: opts.claudeCommand },
    { id: 'pi', adapter: 'pi', command: opts.piCommand },
    { id: 'agy', adapter: 'agy', command: opts.agyCommand },
    { id: 'traex', adapter: 'traex', command: opts.traexCommand },
  ];
}

/** An executable on PATH that looks like another copy of a known agent CLI. */
export interface DiscoveredAgent {
  /** The proposed instance id: the executable's basename. */
  id: string;
  adapter: AgentInstance['adapter'];
  /** The absolute path found on PATH. */
  command: string;
}

/** Basenames of CLIs the hub can already talk to. Anything else (ping, pipx…) is left alone. */
const KNOWN_PREFIXES: Array<[AgentInstance['adapter'], RegExp]> = [
  ['claude', /^claude(?=$|[0-9]|[-_.])/],
  ['pi', /^pi(?=$|[0-9]|[-_.])/],
  ['agy', /^agy(?=$|[0-9]|[-_.])/],
  // traex and the compatibility names its installer creates for the same CLI
  ['traex', /^traex(?=$|[0-9]|[-_.])/],
  ['traex', /^traecli(?=$|[0-9]|[-_.])/],
  ['traex', /^trae-cli(?=$|[0-9]|[-_.])/],
  ['traex', /^trae-agent(?=$|[0-9]|[-_.])/],
  ['traex', /^coco(?=$|[0-9]|[-_.])/],
  ['traex', /^ta(?=$|[0-9]|[-_.])/],
];

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
        if (Array.isArray(parsed.agents) && parsed.agents.length > 0) instances = parsed.agents;
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
    };
    this.register(instance);
    await this.persist();
    return instance;
  }

  private async persist(): Promise<void> {
    const file = this.file;
    if (!file) return;
    const body = JSON.stringify({ agents: this.list() }, null, 2) + '\n';
    const fs = await import('node:fs/promises');
    await fs.writeFile(file, body, 'utf8');
  }

  /**
   * Looks along PATH for executables that look like another copy of a known CLI (`agy2`, `claude2`).
   * Only basenames the hub can talk to are offered; the rest of PATH is ignored. The suffix must
   * start with a digit or a separator, so `ping` or `pix` are not mistaken for extra pi CLIs.
   */
  async discover(): Promise<DiscoveredAgent[]> {
    const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
    const taken = new Set([
      ...this.instances.keys(),
      ...[...this.instances.values()].map((i) => basenameOf(i.command) ?? i.id),
    ]);
    const found = new Map<string, DiscoveredAgent>();
    for (const dir of dirs) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue; // unreadable or gone
      }
      for (const name of names) {
        if (taken.has(name) || found.has(name)) continue;
        const adapter = KNOWN_PREFIXES.find(([, re]) => re.test(name))?.[0];
        if (!adapter) continue;
        const full = join(dir, name);
        try {
          if (!statSync(full).isFile()) continue;
        } catch {
          continue;
        }
        found.set(name, { id: name, adapter, command: full });
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
