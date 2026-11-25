import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiRpcAdapter } from '../src/adapters/pi.js';
import type { AgentAdapter } from '../src/adapters/types.js';
import { AttachmentStore } from '../src/attachments.js';
import { BorrowingService } from '../src/borrowing.js';
import { borrowingServer } from '../src/borrowing-server.js';
import { SOCKET_IN_HOME } from '../src/config.js';
import { HostRegistry } from '../src/hosts.js';
import { createHttpServer, listenPrivate } from '../src/http.js';
import { RelayClient } from '../src/relay-client.js';
import { Store } from '../src/store.js';
import { ThreadManager } from '../src/threads.js';
import { Workdirs } from '../src/workdirs.js';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'bin', 'calli');
const TOKEN = 'remote-exec-test-token-0123456789';

let root: string;
let hubBase: string;
let hubServer: Server;
let toolsServer: Server;
let nodeServer: Server;
let hosts: HostRegistry;
let client: RelayClient;
let threadEnv: Record<string, string>;
const closers: Array<() => Promise<void> | void> = [];

async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for relay');
    await new Promise(r => setTimeout(r, 25));
  }
}

function runCli(args: string[], env: Record<string, string>, input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = execFile(process.execPath, [CLI, ...args], {
      env: { PATH: process.env.PATH ?? '', ...env },
      timeout: 15_000,
    }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? Number((err as { code: number }).code) : err ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

function makeManager(name: string) {
  const dataDir = join(root, `${name}-data`);
  const workdir = join(root, `${name}-work`);
  mkdirSync(workdir, { recursive: true });
  const adapters = new Map<string, AgentAdapter>();
  adapters.set('pi', new PiRpcAdapter([process.execPath, join(here, 'fixtures', 'fake-pi.mjs')]));
  const store = new Store(dataDir);
  const manager = new ThreadManager(
    store,
    adapters,
    new Workdirs([workdir], join(dataDir, 'workdirs.json'), join(dataDir, 'scratch')),
    new AttachmentStore(dataDir),
  );
  closers.push(async () => {
    await manager.shutdown();
    store.close();
  });
  return { dataDir, workdir, store, manager, adapters };
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'calli-remote-exec-'));
  process.env.PI_CODING_AGENT_DIR = join(root, 'pi-agent');
  const node = makeManager('node');
  const hub = makeManager('hub');

  const nodeSocket = join(root, 'node-home', SOCKET_IN_HOME);
  mkdirSync(dirname(nodeSocket), { recursive: true });
  nodeServer = createHttpServer({ manager: node.manager, trusted: true, token: 'node-unused-0123456789', webDir: null, version: 'node-test' });
  assert.equal(await listenPrivate(nodeServer, nodeSocket), true);
  closers.push(() => { nodeServer.close(); nodeServer.closeAllConnections(); });

  hosts = new HostRegistry({ file: join(hub.dataDir, 'hosts.json') });
  closers.push(() => hosts.dispose());
  const toolsSocket = join(hub.dataDir, 'tools', 'calli.sock');
  const borrowing = new BorrowingService(hub.store, hub.manager, hub.adapters, hub.dataDir, toolsSocket);
  borrowing.hosts = hosts;
  closers.push(() => borrowing.dispose());
  toolsServer = borrowingServer(borrowing);
  assert.equal(await listenPrivate(toolsServer, toolsSocket), true);
  closers.push(() => { toolsServer.close(); toolsServer.closeAllConnections(); });

  hubServer = createHttpServer({ manager: hub.manager, hosts, token: TOKEN, webDir: null, version: 'hub-test' });
  await new Promise<void>(r => hubServer.listen(0, '127.0.0.1', () => r()));
  closers.push(() => { hubServer.close(); hubServer.closeAllConnections(); });
  hubBase = `http://127.0.0.1:${(hubServer.address() as AddressInfo).port}`;

  const added = hosts.add({ label: 'Test Mac' });
  client = new RelayClient({ hubUrl: hubBase, token: added.token, socket: nodeSocket, version: 'node-test', retryMs: 50 });
  closers.push(() => client.stop());
  client.start();
  await waitFor(() => hosts.list().some(h => h.id === added.id && h.status === 'online'));

  const thread = await hub.manager.createThread({ agent: 'pi', cwd: hub.workdir, title: 'exec-test' });
  threadEnv = borrowing.environment(thread.id)!;
  assert.ok(threadEnv?.CALLI_TOOLS_SOCKET && threadEnv?.CALLI_TOOLS_KEY);
});

after(async () => {
  for (const close of closers.reverse()) await close();
  rmSync(root, { recursive: true, force: true });
});

test('calli remote hosts lists connected machines via thread socket and operator HTTP', async () => {
  const fromThread = await runCli(['remote', 'hosts'], threadEnv);
  assert.equal(fromThread.code, 0, fromThread.stderr);
  const threadList = JSON.parse(fromThread.stdout);
  assert.equal(threadList.length, 1);
  assert.equal(threadList[0].id, 'test-mac');
  assert.equal(threadList[0].status, 'online');

  const fromHttp = await runCli(['remote', 'hosts'], { CALLI_URL: hubBase, CALLI_TOKEN: TOKEN });
  assert.equal(fromHttp.code, 0, fromHttp.stderr);
  assert.deepEqual(JSON.parse(fromHttp.stdout), threadList);
});

test('calli remote exec forwards argv safely including quotes, Chinese text, and --help after --', async () => {
  const script = 'console.log(JSON.stringify(process.argv.slice(1)))';
  const res = await runCli(
    ['remote', 'exec', 'test-mac', '--', process.execPath, '-e', script, 'Gemini会员买好了没有', "it's ok", '--help'],
    threadEnv,
  );
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), ['Gemini会员买好了没有', "it's ok", '--help']);
});

test('calli remote exec supports -c shell mode, --input-file -, --json, and non-zero exit codes', async () => {
  const shellRes = await runCli(
    ['remote', 'exec', 'test-mac', '--json', '--input-file', '-', '-c', `${process.execPath} -e "const s=require('fs').readFileSync(0,'utf8'); process.stdout.write('in:'+s); process.stderr.write('err-line'); process.exit(3)"`],
    { CALLI_URL: hubBase, CALLI_TOKEN: TOKEN },
    'hello-stdin',
  );
  assert.equal(shellRes.code, 3);
  const parsed = JSON.parse(shellRes.stdout);
  assert.equal(parsed.machine, 'test-mac');
  assert.equal(parsed.code, 3);
  assert.equal(parsed.stdout, 'in:hello-stdin');
  assert.equal(parsed.stderr, 'err-line');
});

test('calli remote exec rejects unknown machine and conflicting command flags', async () => {
  const missing = await runCli(['remote', 'exec', 'no-such-machine', '--', 'echo', 'hi'], threadEnv);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /unknown machine/);

  const conflict = await runCli(['remote', 'exec', 'test-mac', '-c', 'echo a', '--', 'echo', 'b'], threadEnv);
  assert.notEqual(conflict.code, 0);
  assert.match(conflict.stderr, /not both/);
});
