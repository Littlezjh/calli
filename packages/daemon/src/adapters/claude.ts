import { execFile } from 'node:child_process';
import { claudeLiveUsage } from './session-usage.js';
import type { UsageSample } from '../telemetry.js';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AcpAdapter, AcpSession, airForkPoint } from './acp.js';
import { CLAUDE_ICON } from './icons.js';
import type { JsonRpcPeer } from './jsonrpc.js';
import { installJsonMcpServer, jsonMcpServers, removeJsonMcpServer } from '../mcp-format.js';
import { configDirectory, findSessionFile, quoteArg } from './session-location.js';
import { claudeSystemPromptLine, scanJsonl } from './system-prompt.js';
import type { DiscoveredAccount, McpServerInfo, ModelOption, PermissionMode, PlanQuota, QuotaWindow, SkillDir, SlashCommand, SystemPrompt } from './types.js';

/**
 * Claude Code, through the ACP bridge this repo ships with (`@agentclientprotocol/claude-agent-acp`).
 * The protocol handling lives in acp.ts; what is Claude-specific:
 * - its permission modes: "auto" (Claude decides which actions are risky) is the closest match for
 *   auto_edit, acceptEdits is the fallback when the account or adapter version does not offer it;
 * - it answers /cost and /stats in a session without announcing them;
 * - the model list says nothing about which models this account can use, so each model is selected
 *   once in a throw-away session to check.
 */

/**
 * Our permission levels mapped to Claude's session modes, in order of preference.
 * "auto" (Claude decides which actions are risky) is the closest match for auto_edit;
 * acceptEdits is the fallback when the account or adapter version does not offer it.
 */
const CLAUDE_MODE_IDS: Record<PermissionMode, readonly string[]> = {
  ask: ['default'],
  auto_edit: ['auto', 'acceptEdits'],
  full_access: ['bypassPermissions'],
};

/** Effort levels Claude accepts through the `effort` config option. */
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * Commands Claude answers in an ACP session without announcing them (checked by sending each one).
 * Most other terminal-only commands, such as /status and /help, answer "isn't available in this
 * environment"; the hub offers its own status panel instead.
 */
const UNLISTED_COMMANDS: SlashCommand[] = [
  { name: 'goal', description: '设置原生目标并持续执行；不带参数查看，clear 清除', hint: '[目标 | clear]', kind: 'command' },
  { name: 'cost', description: 'Show plan usage limits and what is using them' },
  { name: 'stats', description: 'Show plan usage limits and what is using them' },
];

/** The agent's list plus the commands it answers but does not list, without duplicates. */
export function withUnlistedCommands(listed: SlashCommand[]): SlashCommand[] {
  if (listed.length === 0) return listed; // no session yet: nothing is known about this agent's commands
  const names = new Set(listed.map((c) => c.name));
  return [...listed, ...UNLISTED_COMMANDS.filter((c) => !names.has(c.name))];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "Oct 10, 12:40pm" as the CLI prints it: no year, no timezone beyond the "(UTC)" around it.
 * The year is this one, or next one when that would land the reset in the past.
 */
function claudeResetAt(text: string, now: Date): string | undefined {
  const m = /^(\w{3}) (\d{1,2}), (\d{1,2})(?::(\d{2}))?(am|pm)$/.exec(text.trim());
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1]);
  const day = Number(m[2]);
  const hour = Number(m[3]) % 12 + (m[5] === 'pm' ? 12 : 0);
  for (const year of [now.getUTCFullYear(), now.getUTCFullYear() + 1]) {
    const ts = Date.UTC(year, month, day, hour, Number(m[4] ?? 0));
    if (ts >= now.getTime() - 30 * 86_400_000) return new Date(ts).toISOString();
  }
  return undefined;
}

/**
 * `claude -p "/usage"` output, such as:
 *   Current session: 95% used · resets Oct 10, 12:40pm (UTC)
 *   Current week (all models): 40% used · resets Oct 11, 7am (UTC)
 * Lines that do not match (the advice below, the cost table) are ignored.
 */
export function parseClaudeUsage(text: string, now = new Date()): QuotaWindow[] {
  const out: QuotaWindow[] = [];
  for (const line of text.split('\n')) {
    const m = /^Current (session|week(?: \(all models\))?): (\d+)% used(?: · resets ([^(]+?)\(UTC\))?$/.exec(line.trim());
    if (!m) continue;
    out.push({
      label: m[1] === 'session' ? '5H' : '7D',
      ...(m[1] !== 'session' ? { scope: '全部模型' } : {}),
      usedPercent: Number(m[2]),
      ...(m[3] ? { resetsAt: claudeResetAt(m[3], now) } : {}),
    });
  }
  return out;
}

export class ClaudeAcpAdapter extends AcpAdapter {
  protected override liveUsage(id: string, cwd: string, emit: (sample: UsageSample) => void) {
    return claudeLiveUsage(id, cwd, this.env, emit);
  }
  readonly id = 'claude';
  readonly label = 'Claude Code';
  readonly icon = CLAUDE_ICON;
  readonly capabilities = {
    workModes: ['execute', 'plan'] as const,
    speed: true,
    goal: { controls: ['clear'] as const, actions: ['set', 'show', 'clear'] as const },
    coordination: true,
    resume: true,
    approvals: true,
    permissionModes: ['ask', 'auto_edit', 'full_access'] as const,
    effortLevels: CLAUDE_EFFORTS,
    images: true,
    deleteSession: true,
    history: true,
    quota: true,
    compact: true,
    fork: true,
    forkAt: true,
    multiAccount: true,
    // Claude Code finds a conversation from any worktree of its repository, so the copy loads there.
    forkInto: true,
    systemPrompt: true,
  };

  protected forkPointMeta(forkRef: string): Record<string, unknown> {
    return airForkPoint(forkRef);
  }

  protected readonly modeIds = CLAUDE_MODE_IDS;

  protected configureSession(session: AcpSession, peer: JsonRpcPeer): void {
    const prompt = session.prompt.bind(session);
    session.prompt = async (input, hooks) => {
      if (/^\/goal(?:\s|$)/.test(input.text.trim())) {
        if (input.images.length) return { stopReason: 'error', error: '/goal 不接受图片。' };
        if (/^\/goal\s+(pause|resume)$/.test(input.text.trim())) return { stopReason: 'error', error: '此原生目标支持 /goal 查看和 /goal clear 清除；停止请使用停止按钮。' };
      }
      return prompt(input, hooks);
    };
    session.controlGoal = async (action) => {
      if (action !== 'clear') throw new Error('此 agent 不支持运行中执行该目标操作');
      await session.waitForSubmission();
      await peer.request('_session/goal', { sessionId: session.agentSessionId, action: 'clear' });
      return '已请求清除原生目标。';
    };
  }

  /**
   * Selects each model in turn to learn which effort levels it offers and to drop models this
   * account cannot use. The session comes from the shared probe, which sends no prompt.
   */
  protected refineModels(models: ModelOption[], session: AcpSession): Promise<ModelOption[]> {
    return (async () => {
      const usable: ModelOption[] = [];
      for (const model of models) {
        const settings = await session.probeModel(model.id);
        if (settings === null) {
          console.error(`[claude-acp] model ${model.id} cannot be selected on this account; hiding it`);
          continue;
        }
        usable.push({ ...model, ...settings });
      }
      return usable;
    })();
  }

  protected extraCommands(listed: SlashCommand[]): SlashCommand[] {
    return withUnlistedCommands(listed);
  }

  resumeCommand(agentSessionId: string): string {
    return `claude --resume ${agentSessionId}`;
  }

  /** "You've hit your session limit · resets 10:10am (UTC)", and the weekly and usage variants. */
  planExhausted(message: string): boolean {
    return /hit your (?:\w+ )?limit|usage limit reached/i.test(message);
  }

  async sessionLocation(agentSessionId: string | null, cwd: string) {
    const configDir = configDirectory(this.env, 'CLAUDE_CONFIG_DIR', ['.claude'], cwd);
    // A resumed or forked session can belong to another worktree within this account.
    const sessionPath = await findSessionFile(join(configDir, 'projects'), agentSessionId, 1, (name, id) => name === `${id}.jsonl`);
    return {
      configDir,
      sessionPath,
      ...(agentSessionId ? { resumeCommand: `env CLAUDE_CONFIG_DIR=${quoteArg(configDir)} ${quoteArg(this.env.RAH_CLAUDE_BIN || claudeCli())} --resume ${quoteArg(agentSessionId)}` } : {}),
    };
  }

  /** The system prompt the conversation runs with, from the transcript's own snapshot of it. */
  async readSystemPrompt(agentSessionId: string, cwd: string): Promise<SystemPrompt | null> {
    const { sessionPath } = await this.sessionLocation(agentSessionId, cwd);
    if (!sessionPath) return null;
    let text: string | null = null;
    await scanJsonl(sessionPath, (line) => {
      // The newest snapshot wins: a mid-session change of skills or MCP servers is reflected in it.
      const found = claudeSystemPromptLine(line);
      if (found !== null) text = found;
    });
    return text ? { text, source: 'Claude Code 会话文件' } : null;
  }

  skillDirs(): SkillDir[] {
    // Claude keeps skills in its config dir, `~/.claude/skills` unless CLAUDE_CONFIG_DIR moves it.
    return [{ path: join(configDirectory(this.env, 'CLAUDE_CONFIG_DIR', ['.claude'], process.cwd()), 'skills'), scope: 'personal' }];
  }

  /**
   * User-scope MCP servers, which Claude Code keeps in `.claude.json`: in the config directory
   * once CLAUDE_CONFIG_DIR is set, in the home directory otherwise. The file also holds most of
   * Claude's own state, so writes touch only the one name inside `mcpServers`.
   */
  private mcpJsonPath(): string {
    const configDir = configDirectory(this.env, 'CLAUDE_CONFIG_DIR', ['.claude'], process.cwd());
    const home = this.env.HOME ?? process.env.HOME ?? homedir();
    const explicit = this.env.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR;
    const candidates = explicit ? [join(configDir, '.claude.json'), join(home, '.claude.json')] : [join(home, '.claude.json')];
    return candidates.find((path) => existsSync(path)) ?? candidates[0];
  }

  mcpServers(): McpServerInfo[] {
    return jsonMcpServers(this.mcpJsonPath());
  }

  mcpInstall(name: string, config: Record<string, unknown>): void {
    installJsonMcpServer(this.mcpJsonPath(), name, config);
  }

  mcpRemove(name: string): void {
    if (!removeJsonMcpServer(this.mcpJsonPath(), name)) throw new Error(`claude 没有名为 ${name} 的 MCP 服务`);
  }

  /** One `claude -p "/usage"` run. A local command, so no session is written and no turn spent. */
  async fetchQuota(): Promise<PlanQuota> {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(claudeCli(), ['-p', '/usage'], { timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...process.env, ...this.env } }, (err, out) => {
        if (!err) return resolve(out);
        const reason = String(err.message).split('\n').pop() ?? '';
        reject(new Error(`claude /usage failed: ${reason.slice(0, 200)}`));
      });
    });
    return { windows: parseClaudeUsage(stdout), checkedAt: new Date().toISOString() };
  }

  /**
   * Accounts already signed in on this host: `~/.claude` plus siblings such as `~/.claude-2` that a
   * second login filled in (`CLAUDE_CONFIG_DIR=… claude` leaves credentials there). Each directory
   * is asked through `claude auth status`, a local run that writes no session, so accounts whose
   * login expired drop out of the list on their own. Directories the CLI cannot answer for are
   * skipped rather than reported broken: discovery must never fail the whole scan.
   */
  async discoverAccounts(home = process.env.HOME ?? homedir()): Promise<DiscoveredAccount[]> {
    let names: string[];
    try {
      names = readdirSync(home);
    } catch {
      return []; // no home to look at: nothing to offer
    }
    // Same shape the PATH scan uses for CLIs, so `.claude.json` (a file, not a config directory)
    // or other clutter is left alone; only directories can hold a login.
    const candidates = names
      .filter((name) => /^\.claude(?=$|[0-9]|[-_.])/.test(name))
      .map((name) => join(home, name))
      .filter((dir) => {
        try {
          return statSync(dir).isDirectory();
        } catch {
          return false;
        }
      });
    const found = await Promise.all(
      candidates.map(async (dir): Promise<DiscoveredAccount | null> => {
        const status = await claudeAuthStatus(dir, this.env);
        if (!status?.loggedIn || !status.email) return null;
        return { email: status.email, env: { CLAUDE_CONFIG_DIR: dir }, isDefault: dir === join(home, '.claude') };
      }),
    );
    return found.filter((a): a is DiscoveredAccount => a !== null);
  }
}

/** The claude CLI used for local one-shot runs: quota reads and account discovery. */
function claudeCli(): string {
  return process.env.RAH_CLAUDE_BIN ?? process.env.RAH_CLAUDE_QUOTA_BIN ?? 'claude';
}

/** One `claude auth status` run against a config directory; null when it says nothing usable. */
async function claudeAuthStatus(
  configDir: string,
  extraEnv: Record<string, string>,
): Promise<{ loggedIn?: boolean; email?: string } | null> {
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        claudeCli(),
        ['auth', 'status'],
        { timeout: 15_000, maxBuffer: 64 * 1024, env: { ...process.env, ...extraEnv, CLAUDE_CONFIG_DIR: configDir } },
        (err, out) => (err ? reject(err) : resolve(out)),
      );
    });
    return JSON.parse(stdout) as { loggedIn?: boolean; email?: string };
  } catch {
    return null; // not signed in there, or output the hub does not understand
  }
}
