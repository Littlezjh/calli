/**
 * The model, thinking effort and speed last chosen for an instance, so its next new thread
 * starts there instead of at the instance's own default. Kept per device in localStorage.
 */

export interface AgentChoice {
  model?: string;
  effort?: string;
  speed?: string;
}

export type AgentChoices = Record<string, AgentChoice>;

/** Anything unreadable or wrongly shaped gives no remembered choices. */
export function parseAgentChoices(raw: string | null): AgentChoices {
  try {
    const value = JSON.parse(raw ?? '');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: AgentChoices = {};
    for (const [agent, choice] of Object.entries(value as Record<string, unknown>)) {
      if (!agent || !choice || typeof choice !== 'object') continue;
      const kept: AgentChoice = {};
      for (const key of ['model', 'effort', 'speed'] as const) {
        const v = (choice as Record<string, unknown>)[key];
        if (typeof v === 'string' && v) kept[key] = v;
      }
      if (Object.keys(kept).length) out[agent] = kept;
    }
    return out;
  } catch {
    return {};
  }
}

/** A change merges into what is remembered; empty values release their part back to the default. */
export function mergeAgentChoice(all: AgentChoices, agent: string, choice: Partial<Record<keyof AgentChoice, string | null>>): AgentChoices {
  if (!agent) return all;
  const merged: AgentChoice = { ...all[agent] };
  for (const key of ['model', 'effort', 'speed'] as const) {
    const v = choice[key];
    if (v !== undefined) { if (v === null) delete merged[key]; else merged[key] = v; }
  }
  for (const key of ['model', 'effort', 'speed'] as const) {
    if (!merged[key]) delete merged[key];
  }
  const next = { ...all };
  if (Object.keys(merged).length) next[agent] = merged;
  else delete next[agent];
  return next;
}
