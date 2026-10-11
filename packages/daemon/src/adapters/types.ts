import type { ImageInput } from '../attachments.js';
import type { EmittedEvent } from '../events.js';

/** What the user sent in one turn. `text` may be empty when there are images. */
export interface TurnInput {
  text: string;
  images: ImageInput[];
}

export interface PermissionOption {
  optionId: string;
  name: string;
  /** ACP-style kind: allow_once | allow_always | reject_once | reject_always */
  kind: string;
}

export interface ApprovalRequest {
  title: string;
  options: PermissionOption[];
  /** Raw tool-call payload from the agent, shown to the user as-is. */
  toolCall: Record<string, unknown>;
}

export type ApprovalDecision = { optionId: string } | { cancelled: true };

/** Callbacks an adapter uses while a turn is running. */
export interface TurnHooks {
  emit(event: EmittedEvent): void;
  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision>;
}

export interface TurnResult {
  stopReason: 'end_turn' | 'cancelled' | 'error' | string;
  error?: string;
  /**
   * Set for errors the UI can explain better than a raw message.
   * `permission_refused`: the agent could not ask for approval, so it refused `refused` and stopped.
   */
  errorCode?: 'permission_refused';
  refused?: string[];
}

/** A live agent session bound to one thread. */
export interface AgentSession {
  /** Stable id on the agent side, used to resume the session after a restart. */
  readonly agentSessionId: string;
  /** Changes the permission level of a live session. Only called when the adapter lists modes. */
  setPermissionMode?(mode: PermissionMode): Promise<void>;
  /** Returns true if the change applied to the live session; false means the session must restart. */
  setModel?(model: string): Promise<boolean>;
  /** Returns true if the change applied to the live session; false means the session must restart. */
  setEffort?(effort: EffortLevel): Promise<boolean>;
  prompt(input: TurnInput, hooks: TurnHooks): Promise<TurnResult>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Permission levels shared by the UI and the daemon. Each adapter maps these to its own modes.
 * - ask: every action that needs approval asks the user
 * - auto_edit: file edits are approved automatically, other actions still ask
 * - full_access: no approval prompts
 */
export const PERMISSION_MODES = ['ask', 'auto_edit', 'full_access'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Thinking effort, shared by the UI. Each adapter lists the subset it supports. */
export const EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** A slash command the agent understands, shown when the user types "/" in the composer. */
export interface SlashCommand {
  /** Without the leading slash. */
  name: string;
  description: string;
  /** What to type after the command, as the agent describes it. */
  hint?: string;
  /** Set only when the agent says what the command is. Claude does not; pi does. */
  kind?: 'command' | 'prompt' | 'skill';
}

/** One window of a plan's usage, as the agent itself reports it. */
export interface QuotaWindow {
  /** Short chip label, such as "5H" or "7D". */
  label: string;
  /** What the window covers, when the agent splits by model group or model. */
  scope?: string;
  /** How much of the window is used, 0 to 100. */
  usedPercent: number;
  /** When the window resets, if the agent said so. ISO. */
  resetsAt?: string;
}

/** Plan usage of an agent instance, read outside any session so nothing is left behind. */
export interface PlanQuota {
  windows: QuotaWindow[];
  /** When the agent was last asked. ISO. */
  checkedAt: string;
}

export interface ModelOption {
  /** Value sent back when the user picks this model. */
  id: string;
  label: string;
  /** Short note from the agent, such as the concrete version behind an alias. */
  description?: string;
  /**
   * Thinking effort levels this model accepts. An empty list means the model has no effort setting.
   * Left out when the agent does not say, in which case the agent-wide list applies.
   */
  efforts?: EffortLevel[];
  /** False when the model cannot read images. Left out when the agent does not say. */
  images?: boolean;
  /**
   * For a model that cannot read images, how they reach it anyway, such as a tool that hands them to a
   * vision model. Images are then accepted for this model.
   */
  imagesVia?: string;
  /** The model the agent uses when the thread does not pick one. */
  isDefault?: boolean;
}

/** A conversation the agent has on record, whether or not the hub knows about it. */
export interface AgentSessionSummary {
  id: string;
  cwd: string;
  title: string;
  /** ISO time of the last activity, when the agent says. */
  updatedAt: string | null;
}

/** One past exchange, in the shape a live turn would have produced. */
export interface HistoryTurn {
  text: string;
  images: ImageInput[];
  events: EmittedEvent[];
  /**
   * What forkSession needs to copy the conversation as it stood when this turn ended. Only from
   * adapters with capabilities.forkAt, and missing where the agent cannot stop a copy: an adapter
   * may leave it off the last turn, whose copy is the whole conversation anyway.
   */
  forkRef?: string;
}

export interface StartOptions {
  cwd: string;
  /** Agent-side session id to resume, if the thread already has one. */
  resumeId?: string;
  /** Permission level for this session. Adapters without permission modes ignore it. */
  permissionMode?: PermissionMode;
  model?: string;
  effort?: EffortLevel;
}

export interface AgentAdapter {
  readonly id: string;
  readonly label: string;
  readonly capabilities: {
    resume: boolean;
    approvals: boolean;
    /** Permission levels this agent supports. Empty means the UI shows no permission picker. */
    permissionModes: readonly PermissionMode[];
    /** Thinking effort levels this agent supports. Empty means the UI shows no effort picker. */
    effortLevels: readonly EffortLevel[];
    /** Whether a turn may carry images. A model can still opt out through ModelOption.images. */
    images: boolean;
    /** Whether the agent's own copy of a session can be removed when a thread is deleted for good. */
    deleteSession: boolean;
    /** Whether existing conversations can be listed and their history read, for importing. */
    history: boolean;
    /** Whether plan usage can be read outside a session, for the quota panel. */
    quota: boolean;
    /** Whether a conversation can be copied into a new, independent one. */
    fork: boolean;
    /** Whether that copy can stop at an earlier turn instead of taking everything. Needs fork and history. */
    forkAt: boolean;
  };
  /** Whether the agent can be started on this host. */
  available(): Promise<boolean>;
  /** Models the user can pick from. May start a short-lived process to ask the agent. */
  models(): Promise<ModelOption[]>;
  /**
   * Slash commands the agent reports. Project-level commands depend on the directory, so pass the
   * thread's cwd when there is one. May be empty until the agent has announced them.
   */
  commands(cwd?: string): Promise<SlashCommand[]>;
  /** The command that continues this session in a terminal, to be run from the thread's directory. */
  resumeCommand(agentSessionId: string): string;
  /** Removes the agent's own record of a session. Present only when capabilities.deleteSession is true. */
  deleteSession?(agentSessionId: string, cwd: string): Promise<void>;
  /** Every conversation the agent has on record, in any directory. With capabilities.history. */
  listSessions?(): Promise<AgentSessionSummary[]>;
  /** The past turns of a conversation. Reading must not change the conversation. With capabilities.history. */
  loadHistory?(agentSessionId: string, cwd: string): Promise<HistoryTurn[]>;
  /**
   * Folders outside the thread's directory where the agent keeps files it made for this session.
   * Images in them may be shown in the thread, like images in the thread's own directory.
   */
  artifactDirs?(agentSessionId: string): string[];

  /** Plan usage, read outside any session. With capabilities.quota. Cached one layer up. */
  fetchQuota?(): Promise<PlanQuota>;
  /**
   * Copies a conversation and returns the id of the copy. With capabilities.fork. Given a turn's
   * forkRef (with capabilities.forkAt), the copy ends where that turn ended.
   */
  forkSession?(agentSessionId: string, cwd: string, forkRef?: string): Promise<string>;
  start(opts: StartOptions): Promise<AgentSession>;
}
