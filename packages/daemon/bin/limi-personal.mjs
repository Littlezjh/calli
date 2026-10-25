import { readFileSync } from 'node:fs';
import { transport } from './limi-tools.mjs';
export const personalHelp = `limi todo
limi todo show ID
limi todo delegate ID
limi todo add --owner agent|me --text-file FILE|- [--parent ID] [--due TIME]
limi todo update ID --rev N [--state open|waiting|done] [--waiting-on TEXT] [--due TIME] [--follow-up TIME] [--note-file FILE|-]
limi todo propose-done ID --rev N --evidence-file FILE|-
limi wish --text-file FILE|-
limi quiet
limi review on|off|status
limi review next TIME
Review next accepts 30 minutes to 3 days from now; the result reports nextReviewAt and adjustment reasons: quiet_hours, daily_limit, idle_backoff.
Reviews only ask; delegate only after the person explicitly says to start.
todo, review and wish use LIMI_TODO_SOCKET / LIMI_TODO_KEY, only in the personal directory.
quiet uses LIMI_TOOLS_SOCKET / LIMI_TOOLS_KEY in any thread.
In linked threads, self: true marks the current thread. Other linked threads are records only: you do not need and cannot read their history; handover/history are only for a handover chain.
Read before writing: stale rev returns 409. For me commitments use propose-done; only the person can mark them done.
After changing a todo, update its continuation note before ending the turn (maximum 4000 Unicode characters).
Note sections: ## 欠谁什么 / ## 定了什么（包括否决的路线和原因） / ## 做到哪（已完成的、可能仍在执行的，比如已提交但未确认的表单） / ## 下一步
Do not store credentials in notes. TIME is ISO 8601; missing timezone means daemon local time. An empty TIME clears it.
quiet suppresses routine completion notifications for this turn; wish never marks a thread unread.`;
export async function personalMain(args) {
  const [group, ...rest] = args;
  if (group === 'review') {
    const [action, time, extra] = rest;
    if (!['on', 'off', 'status', 'next'].includes(action) || extra !== undefined || (action === 'next' ? !time : time !== undefined)) throw new Error(personalHelp);
    console.log(JSON.stringify(await transport('/command', { op: `review.${action}`, ...(action === 'next' ? { time } : {}) }, false, true))); return;
  }
  const command = group === 'todo' ? (rest.shift() ?? 'list') : group;
  const input = { op: group === 'todo' ? `todo.${command}` : group };
  if (['show', 'update', 'propose-done', 'delegate'].includes(command)) {
    input.id = rest.shift(); if (!input.id || input.id.startsWith('--')) throw new Error(personalHelp);
  }
  const allowed = { list: [], show: [], delegate: [], add: ['--owner', '--text-file', '--parent', '--due'], update: ['--rev', '--state', '--waiting-on', '--due', '--follow-up', '--note-file'], 'propose-done': ['--rev', '--evidence-file'], wish: ['--text-file'], quiet: [] }[command];
  if (!allowed) throw new Error(personalHelp);
  const fields = { '--owner': 'owner', '--parent': 'parentId', '--due': 'dueAt', '--rev': 'rev', '--state': 'state', '--waiting-on': 'waitingOn', '--follow-up': 'followUpAt', '--text-file': 'text', '--note-file': 'note', '--evidence-file': 'evidence' };
  const seen = new Set();
  while (rest.length) {
    const key = rest.shift(), value = rest.shift();
    if (!allowed.includes(key) || value === undefined || seen.has(key)) throw new Error(personalHelp);
    seen.add(key);
    input[fields[key]] = key.endsWith('-file') ? readFileSync(value === '-' ? 0 : value, 'utf8') : key === '--rev' ? Number(value) : value;
  }
  if (command === 'add' && (!seen.has('--owner') || !seen.has('--text-file')) || command === 'wish' && !seen.has('--text-file') || ['update', 'propose-done'].includes(command) && !seen.has('--rev') || command === 'propose-done' && !seen.has('--evidence-file')) throw new Error(personalHelp);
  if (group === 'quiet' && (!process.env.LIMI_TOOLS_SOCKET || !process.env.LIMI_TOOLS_KEY)) throw new Error('quiet requires thread-scoped credentials');
  console.log(JSON.stringify(await transport('/command', input, false, group !== 'quiet')));
}
