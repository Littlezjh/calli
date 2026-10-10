/** Permission levels as the UI shows them. Values match the daemon's PERMISSION_MODES. */
export const PERMISSION_LABELS: Record<string, { label: string; short: string; hint: string }> = {
  ask: { label: '请求批准', short: '请求批准', hint: '修改文件和运行命令前都先询问' },
  auto_edit: { label: '帮我批准', short: '帮我批准', hint: '常规操作自动通过，只在有风险时询问' },
  full_access: { label: '完全访问权限', short: '完全访问', hint: '不再询问，可直接修改文件和运行命令' },
};

/**
 * What a level means for this agent. An agent that cannot ask (it runs without a terminal) refuses
 * whatever it would have asked about, so "auto" there means edits only.
 */
export function permissionHint(mode: string, canAsk: boolean): string {
  if (mode === 'auto_edit' && !canAsk) return '自动修改文件；运行命令等需要批准的操作会被拒绝';
  return PERMISSION_LABELS[mode]?.hint ?? '';
}

/** Stable order for the picker: from most to least restrictive. */
export const PERMISSION_ORDER = ['ask', 'auto_edit', 'full_access'];

export const EFFORT_LABELS: Record<string, string> = {
  off: '关闭',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最大',
};
