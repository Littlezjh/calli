/**
 * End-to-end harness: builds the web UI, starts the daemon against the fake agents from
 * packages/daemon/test/fixtures, and drives a real browser through playwright-core.
 *
 * The browsers come from wherever they are: the playwright cache, or a system Chrome.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, '..');
const fixtures = join(repoRoot, 'daemon', 'test', 'fixtures');

export const TOKEN = 'e2e-token-0123456789abcdef';

/** Builds both packages once for a whole test run. Slow, so callers cache the promise. */
let buildPromise = null;
export function buildOnce() {
  buildPromise ??= new Promise((resolve, reject) => {
    try {
      execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
  return buildPromise;
}

/** A free TCP port, so parallel test files do not fight over one. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** Wraps a fixture script in an executable shell shim, so `RAH_*_BIN` can point at a plain name. */
function shim(dir, name, script) {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${join(fixtures, script)}" "$@"\n`, { mode: 0o755 });
  return path;
}

/**
 * One daemon with its own data dir, workdir and fake agents. Returns the base URL plus handles.
 * `env` is merged into the daemon's environment (extra RAH_* switches, fake-agent switches).
 */
export async function startDaemon(env = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'rah-e2e-data-'));
  const workdir = mkdtempSync(join(tmpdir(), 'rah-e2e-work-'));
  const binDir = join(dataDir, 'bin');
  mkdirSync(binDir);
  shim(binDir, 'fake-pi', 'fake-pi.mjs');
  shim(binDir, 'fake-claude', 'fake-acp.mjs');
  shim(binDir, 'fake-agy', 'fake-agy.mjs');
  // For the tests of other machines: `RAH_SSH_BIN: 'fake-ssh'` makes directories stand in for them.
  shim(binDir, 'fake-ssh', 'fake-ssh.mjs');
  // An extra CLI for the discovery tests: looks like another copy of agy on PATH.
  if (env.RAH_E2E_DISCOVER_AGY2 === '1') shim(binDir, 'agy2', 'fake-agy.mjs');

  const port = await freePort();
  const daemonEnv = {
    ...process.env,
    // The fake agents are shims in binDir, so that directory leads the PATH.
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    RAH_TOKEN: TOKEN,
    RAH_HOST: '127.0.0.1',
    RAH_PORT: String(port),
    RAH_DATA_DIR: dataDir,
    RAH_WORKDIRS: workdir,
    // Serve this repo's own build, never a dist inherited from the ambient environment.
    RAH_WEB_DIR: join(repoRoot, 'web', 'dist'),
    RAH_PI_BIN: 'fake-pi',
    RAH_CLAUDE_ACP_BIN: 'fake-claude',
    RAH_AGY_BIN: 'fake-agy',
    PI_CODING_AGENT_DIR: join(dataDir, 'pi-agent'),
    RAH_AGY_HOME: join(dataDir, 'agy-home'),
    ZCODE_DATA_BASE_DIR: dataDir,
    // Its own socket, never the one in the home directory that a real hub on this machine holds.
    RAH_SOCKET: join(dataDir, 'daemon.sock'),
    ...env,
  };
  const child = spawn(process.execPath, [join(repoRoot, 'daemon', 'dist', 'index.js')], {
    env: daemonEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (c) => (log += c));
  child.stderr.on('data', (c) => (log += c));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`daemon did not start; log:\n${log}`);
    if (child.exitCode !== null) throw new Error(`daemon exited with ${child.exitCode}; log:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    base,
    token: TOKEN,
    dataDir,
    workdir,
    binDir,
    log: () => log,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((r) => child.on('exit', r));
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}

/** Finds a Chromium the installed playwright-core can drive: the cache, then a system Chrome. */
export function launchBrowser() {
  const home = process.env.HOME ?? '';
  const candidates = [
    `${home}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ];
  return (async () => {
    try {
      return await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    } catch {
      // fall through to an explicit executable
    }
    let lastErr;
    for (const executablePath of candidates) {
      if (!existsSync(executablePath)) continue;
      try {
        return await chromium.launch({ headless: true, args: ['--no-sandbox'], executablePath });
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error('no Chromium found for e2e tests');
  })();
}

/** Opens the UI and signs in with the token, ready for test steps. Idempotent per page. */
export async function openUi(page, daemon) {
  await page.goto(daemon.base + '/');
  const input = page.getByLabel('access token');
  if (await input.count()) {
    await input.fill(daemon.token);
    await page.getByRole('button', { name: '进入' }).click();
  }
  // On phones the sidebar is a drawer: it exists but is not visible until opened.
  await page.locator('.sidebar-inner').waitFor({ state: 'attached', timeout: 15_000 });
}

/** Signed fetch against the daemon's API, for arranging state outside the UI. */
export function api(daemon, path, init = {}) {
  return fetch(daemon.base + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${daemon.token}`, ...(init.headers ?? {}) },
  });
}
