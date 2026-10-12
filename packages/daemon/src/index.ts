import { loadConfig, loadDotEnv } from './config.js';
import { createHttpServer } from './http.js';
import { AgentRegistry, defaultInstances } from './agents.js';
import { AttachmentStore } from './attachments.js';
import { Store } from './store.js';
import { TerminalManager } from './terminals.js';
import { ThreadManager } from './threads.js';
import { Workdirs } from './workdirs.js';
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
  const manager = new ThreadManager(store, adapters, dirs, new AttachmentStore(config.dataDir));
  manager.recoverInterrupted();
  const terminals = new TerminalManager({ workdirs: () => dirs.all(), shell: config.termShell ?? undefined });
  const server = createHttpServer({ manager, registry, terminals, token: config.token, webDir: config.webDir, version: VERSION });

  server.listen(config.port, config.host, () => {
    console.log(`remote-agent-hub daemon ${VERSION} listening on http://${config.host}:${config.port}`);
    console.log(`workdirs: ${dirs.roots().join(', ')}`);
    if (config.host === '0.0.0.0' || config.host === '::') {
      console.warn('warning: listening on all interfaces. Bind to the VPN address instead.');
    }
  });

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down`);
    server.close();
    await manager.shutdown();
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
