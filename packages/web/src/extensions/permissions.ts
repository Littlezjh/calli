import type { ExtensionState, Permission } from '@rah/extension-api';

/** Consent belongs to this exact manifest, including when an update removes a permission. */
export function exactGrant(state: ExtensionState): boolean {
  const { permissions } = state.manifest;
  return state.granted.length === permissions.length && new Set(state.granted).size === state.granted.length
    && permissions.every(permission => state.granted.includes(permission));
}

export const needsConfirm = (state: ExtensionState) => state.installed && !exactGrant(state);

export function hasPermission(state: ExtensionState | null, permission: Permission): boolean {
  return Boolean(state?.installed && state.enabled && exactGrant(state) && state.manifest.permissions.includes(permission));
}
