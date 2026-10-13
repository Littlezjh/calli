import { CoordinationManager, coordinationServer } from './coordination.js';
import { loadConfig, loadDotEnv } from './config.js';
import { createHttpServer, listenPrivate } from './http.js';
import { HostRegistry } from './hosts.js';
import { AgentRegistry, defaultInstances } from './agents.js';
import { AttachmentStore } from './attachments.js';
import { Scheduler } from './scheduler.js';
import { Store } from './store.js';
import { TerminalManager } from './terminals.js';
import { ThreadManager } from './threads.js';
import { Workdirs } from './workdirs.js';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

export const VERSION = '0.1.0';

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();

  // Empty RAH_WORKDIRS means "only the directory the daemon was started in".
  const workdirs = config.workdirs.length > 0 ? config.workdirs : [process.cwd()];

  // Agent instances come from agents.json (or the built-in defaults): one adapter each, so the
  // same protocol can back several accounts or CLIs.
  const registry = AgentRegistry.fromEnv({
    dataDir: config.dataDir,
    env: process.env,
    defaults: defaultInstances({
      claudeCommand: config.claudeCommand,
      piCommand: config.piCommand,
      agyCommand: config.agyCommand,
      traexCommand: config.traexCommand,
      codexCommand: config.codexCommand,
    }),
  });
  const adapters = registry.adapters;

  // Model lists take a few seconds to probe, so start now instead of on the first page load.
  for (const a of adapters.values()) {
    void a
      .available()
      .then((ok) => (ok ? a.models() : []))
      .catch((err) => console.error(`[${a.id}] could not read the model list: ${err instanceof Error ? err.message : err}`));
  }

  const store = new Store(config.dataDir);
  // Directories added from the page are kept next to the hub's data; threads in no project work in
  // a scratch area there too.
  const dirs = new Workdirs(workdirs, join(config.dataDir, 'workdirs.json'), join(config.dataDir, 'scratch'));
  const manager = new ThreadManager(store, adapters, dirs, new AttachmentStore(config.dataDir), () => registry.list());
  manager.recoverInterrupted();
  // Scheduled tasks tick on their own, on the machine where their threads live.
  const scheduler = new Scheduler(store, manager, adapters);
  scheduler.start();
  const coordinationPath = join(config.dataDir, 'coordination', 'limi.sock');
  const coordination = new CoordinationManager(store, manager, coordinationPath);
  const collaborationServer = coordinationServer(coordination);
  if (!await listenPrivate(collaborationServer, coordinationPath)) throw new Error('Collaboration socket is already in use');
  const terminals = new TerminalManager({ workdirs: () => dirs.all(), shell: config.termShell ?? undefined });
  // Other machines, each reached over SSH through its daemon's socket.
  const hosts = new HostRegistry({ file: join(config.dataDir, 'hosts.json'), ssh: config.sshCommand });
  hosts.start();
  // Previews are served on a port of their own: the iframe needs an origin separate from the app
  // (see preview.ts). One port past the app's is the default; RAH_PREVIEW_PORT picks another.
  const previewPort = Number(process.env.RAH_PREVIEW_PORT) || config.port + 1;
  const server = createHttpServer({ manager, registry, terminals, hosts, scheduler, token: config.token, webDir: config.webDir, version: VERSION, previewPort });
  // Same requests, other origin: preview frames load from here so their pages cannot reach the
  // app, while their own CSS and scripts load same-origin. Without the port, previews say so.
  const preview = createHttpServer({ manager, registry, terminals, hosts, scheduler, token: config.token, webDir: null, version: VERSION, previewPort });
  preview.on('error', (err: NodeJS.ErrnoException) => {
    console.warn(`warning: preview port ${previewPort} unavailable (${err.code}); previews disabled`);
  });
  preview.listen(previewPort, config.host, () => console.log(`previews on http://${config.host}:${previewPort}`));
  // The same API on a socket only this user can open: how a hub on another machine reaches this one.
  const local = config.socket ? createHttpServer({ manager, registry, terminals, scheduler, trusted: true, token: config.token, webDir: null, version: VERSION }) : null;
  let ownsSocket = false;
  if (local && config.socket) {
    listenPrivate(local, config.socket)
      .then((ok) => {
        ownsSocket = ok;
        console.log(ok ? `socket: ${config.socket}` : `socket: ${config.socket} belongs to another daemon, not listening on it`);
      })
      .catch((err) => console.warn(`warning: could not listen on ${config.socket}: ${err instanceof Error ? err.message : err}`));
  }

  server.listen(config.port, config.host, () => {
    console.log(`Limi daemon ${VERSION} listening on http://${config.host}:${config.port}`);
    console.log(`workdirs: ${dirs.roots().join(', ')}`);
    if (config.host === '0.0.0.0' || config.host === '::') {
      console.warn('warning: listening on all interfaces. Bind to the VPN address instead.');
    }
  });

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down`);
    server.close();
    preview.close();
    local?.close();
    // Open event streams keep the server from closing by itself; the socket goes now, so a hub
    // that looks does not take a stopped daemon for a running one.
    if (ownsSocket && config.socket) rmSync(config.socket, { force: true });
    hosts.dispose();
    coordination.dispose();
    collaborationServer.close();
    rmSync(coordinationPath, { force: true });
    await manager.shutdown();
    scheduler.dispose();
    terminals.dispose();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
