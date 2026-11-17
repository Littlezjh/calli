/**
 * Quota-exhaustion wording shared by the adapters whose agents sit on the same GLM Coding Plan
 * gateways (BigModel / Z.ai) or word their subscription limits the same way. Only patterns seen
 * in real turn errors are matched (see docs/auto-handover.md, 套餐耗尽证据): a plain 429 rate
 * limit stays a transient failure, never a plan running out.
 */

/** GLM's plan windows ran out: the request id wrappers differ per CLI, the wording does not. */
export function glmQuotaExhausted(message: string): boolean {
  return /insufficient_quota|exceeded the quota|ZCode: \[13\d\d\]|已达到[^。]{0,12}上限|"code":"13(?:08|10)"/i.test(message);
}

/** A subscription's individual quota, as Claude and Gemini word it while naming the reset. */
export function individualQuotaExhausted(message: string): boolean {
  return /Individual quota reached/i.test(message);
}

/**
 * The reset time a quota error promised, as an ISO instant; null when it names none. GLM's
 * datetimes are Beijing wall clock (UTC+8) whatever the host's zone is; the relative form counts
 * from `now`. Guarded to a sane range so a mangled message cannot pin a watch years out.
 */
export function quotaResetFrom(message: string, now = new Date()): string | null {
  const cjk = /将在 (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) 重置/.exec(message);  if (cjk) {
    const at = Date.UTC(Number(cjk[1]), Number(cjk[2]) - 1, Number(cjk[3]), Number(cjk[4]) - 8, Number(cjk[5]), Number(cjk[6]));
    return sane(at, now.getTime());
  }
  const relative = /Resets in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/.exec(message);
  if (relative && (relative[1] || relative[2] || relative[3])) {
    const span = (Number(relative[1] ?? 0) * 3600 + Number(relative[2] ?? 0) * 60 + Number(relative[3] ?? 0)) * 1000;
    return sane(now.getTime() + span, now.getTime());
  }
  return null;
}

/** Keeps a parsed reset within the window a plan could plausibly promise: a minute out, a month in. */
function sane(at: number, now: number): string | null {
  return at > now + 60_000 && at < now + 31 * 24 * 3600_000 ? new Date(at).toISOString() : null;
}
