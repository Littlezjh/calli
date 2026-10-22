/**
 * A throwaway hub for checking work by hand: the e2e harness's daemon (own port, data dir,
 * workdir and fake agents), plus a smoke test of one turn. Never touches the real hub.
 *
 *   node packages/e2e/dev-instance.mjs           start, smoke test, keep running until Ctrl-C
 *   node packages/e2e/dev-instance.mjs --check   start, smoke test, stop
 *
 * Expects a build; scripts/init.sh builds first.
 */
import { startDaemon, api } from './harness.mjs';

const check = process.argv.includes('--check');

async function smoke(daemon) {
  const agents = await (await api(daemon, '/api/agents')).json();
  if (!agents.some((a) => a.id === 'pi' && a.available)) throw new Error('fake pi agent is not available');
  const html = await fetch(daemon.base + '/');
  if (!html.ok) throw new Error(`GET / answered ${html.status}`);

  const res = await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: daemon.workdir, title: 'smoke' }) });
  if (res.status !== 201) throw new Error(`creating a thread answered ${res.status}`);
  const thread = await res.json();
  const sent = await api(daemon, `/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'hello' }) });
  if (!sent.ok) throw new Error(`sending a turn answered ${sent.status}`);
  const deadline = Date.now() + 20_000;
  for (;;) {
    const t = await (await api(daemon, `/api/threads/${thread.id}`)).json();
    if (t.status === 'idle') break;
    if (Date.now() > deadline) throw new Error(`the smoke turn did not finish; status ${t.status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  // The fake pi answers "hi there <text>"; a turn that errored ends idle too, without it.
  const events = await (await api(daemon, `/api/threads/${thread.id}/events`)).json();
  const answer = events.filter((e) => e.type === 'message.delta').map((e) => e.data.text).join('');
  if (!events.some((e) => e.type === 'turn.done') || !answer.startsWith('hi there hello')) {
    throw new Error(`the smoke turn did not answer; events:\n${JSON.stringify(events, null, 1)}`);
  }
}

const daemon = await startDaemon();
let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  await daemon.stop();
  process.exit(code);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

try {
  await smoke(daemon);
} catch (err) {
  console.error(`Smoke test failed: ${err.message}\n--- daemon log ---\n${daemon.log()}`);
  await stop(1);
}

console.log(`Smoke test passed.
  URL      ${daemon.base}/
  Token    ${daemon.token}
  PID      ${daemon.pid} (daemon), ${process.pid} (this script)
  Data     ${daemon.dataDir}
  Workdir  ${daemon.workdir}`);
if (check) await stop(0);
else console.log(`Running. Stop with Ctrl-C, or: kill ${process.pid}  (cleans up the daemon and its temp dirs)`);
