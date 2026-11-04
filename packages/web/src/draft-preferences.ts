export interface DraftModelPreference {
  model: string | null;
  effort: string | null;
  speed: string | null;
}

export const EMPTY_DRAFT_MODEL_PREFERENCE: DraftModelPreference = {
  model: null,
  effort: null,
  speed: null,
};

function cloneDraftModelPreference(value: DraftModelPreference): DraftModelPreference {
  return { model: value.model, effort: value.effort, speed: value.speed };
}

/**
 * Keeps the unsent model controls scoped to the agent they belong to, so switching accounts does
 * not make the previous agent forget what the person had just chosen for a new thread.
 */
export function switchDraftModelPreference(
  preferences: Record<string, DraftModelPreference>,
  currentAgent: string,
  current: DraftModelPreference,
  nextAgent: string,
): { preferences: Record<string, DraftModelPreference>; preference: DraftModelPreference } {
  if (currentAgent === nextAgent) {
    return { preferences, preference: cloneDraftModelPreference(current) };
  }
  const nextPreferences = currentAgent
    ? { ...preferences, [currentAgent]: cloneDraftModelPreference(current) }
    : preferences;
  if (!nextAgent) {
    return { preferences: nextPreferences, preference: cloneDraftModelPreference(EMPTY_DRAFT_MODEL_PREFERENCE) };
  }
  return {
    preferences: nextPreferences,
    preference: cloneDraftModelPreference(nextPreferences[nextAgent] ?? EMPTY_DRAFT_MODEL_PREFERENCE),
  };
}
