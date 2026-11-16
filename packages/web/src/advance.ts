import { t } from './i18n';
import type { AdvanceView } from './api';

/** A next-check time as a short local note: "17:00" today, "10/12 17:00" later. */
export function advanceClock(iso: string, now = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const hm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return at.toDateString() === now.toDateString() ? hm : `${at.getMonth() + 1}/${at.getDate()} ${hm}`;
}

/**
 * The quiet line under a thread's last turn: what the daemon will do on its own and when — what a
 * wait waits for with the time it next checks, or the upcoming auto-continue attempt with its
 * time. The cancel sits beside it as a button.
 */
export function advanceStatus(view: AdvanceView, now = new Date()): string {
  // Nothing scheduled (a chain that spent its attempts) has no line of its own.
  const time = view.nextAt ? advanceClock(view.nextAt, now) : '';
  if (!time || view.reason !== 'wait') return t('view.advanceContinue', view.attempts + 1, view.max, time);
  // A note that said only how long still gets a subject for the line to hang on.
  const what = view.what?.trim() || t('view.advanceWaiting');
  return t('view.advanceWait', what, time);
}
