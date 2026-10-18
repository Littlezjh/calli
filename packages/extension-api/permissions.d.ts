// What an extension may ask the host for. See docs/extensions-design.md, 「权限」.
// These limit how the host calls extensions; they are not a sandbox: extension processes
// run as the daemon user.

/**
 * - `memory.read`      — generated memory documents of this machine's supported instances. (v1)
 * - `events.summary`   — whitelisted metadata of threads, turns and waits. No message text,
 *                        images, tool input/output, answers, `preview` or queued text. (v1)
 * - `progress.read`    — step snapshots agents report (`plan.updated`), per thread. (planned)
 * - `worksource.read`  — goals and work items from a work source, per source and thread. (planned)
 * - `files.read`       — read-only files in linked threads' directories. (planned)
 * - `commands.run`     — run commands declared in the manifest. (planned)
 * - `notify`           — send reminders through the host. (planned)
 * - `transcript.read`  — user messages and replies of linked threads, never reasoning. (planned)
 * - `toolresult.read`  — tool results and command output of linked threads. (planned)
 * - `task.control`     — send visible messages to threads the user authorised. (planned)
 *
 * Not grantable at all: answering approvals, writing agent directories or config,
 * reading the hub token, the raw Api, changing prompts or rewriting messages.
 */
export type Permission =
  | 'memory.read'
  | 'events.summary'
  | 'progress.read'
  | 'worksource.read'
  | 'files.read'
  | 'commands.run'
  | 'notify'
  | 'transcript.read'
  | 'toolresult.read'
  | 'task.control';
