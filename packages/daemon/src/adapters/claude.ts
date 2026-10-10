import { AcpAdapter, AcpSession } from './acp.js';
import type { ModelOption, PermissionMode, SlashCommand } from './types.js';

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
  { name: 'cost', description: 'Show plan usage limits and what is using them' },
  { name: 'stats', description: 'Show plan usage limits and what is using them' },
];

/** The agent's list plus the commands it answers but does not list, without duplicates. */
export function withUnlistedCommands(listed: SlashCommand[]): SlashCommand[] {
  if (listed.length === 0) return listed; // no session yet: nothing is known about this agent's commands
  const names = new Set(listed.map((c) => c.name));
  return [...listed, ...UNLISTED_COMMANDS.filter((c) => !names.has(c.name))];
}

export class ClaudeAcpAdapter extends AcpAdapter {
  readonly id = 'claude';
  readonly label = 'Claude Code';
  readonly capabilities = {
    resume: true,
    approvals: true,
    permissionModes: ['ask', 'auto_edit', 'full_access'] as const,
    effortLevels: CLAUDE_EFFORTS,
    images: true,
    deleteSession: true,
    history: true,
    fork: true,
  };

  protected readonly modeIds = CLAUDE_MODE_IDS;

  /**
   * Selects each model in turn to learn which effort levels it offers and to drop models this
   * account cannot use. The session comes from the shared probe, which sends no prompt.
   */
  protected refineModels(models: ModelOption[], session: AcpSession): Promise<ModelOption[]> {
    return (async () => {
      const usable: ModelOption[] = [];
      for (const model of models) {
        const efforts = await session.probeModel(model.id);
        if (efforts === null) {
          console.error(`[claude-acp] model ${model.id} cannot be selected on this account; hiding it`);
          continue;
        }
        usable.push({ ...model, efforts });
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
}
