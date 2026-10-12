import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export interface Config {
  host: string;
  port: number;
  token: string;
  dataDir: string;
  /** Directories the UI may start threads in. Empty means the daemon's cwd only. */
  workdirs: string[];
  /** Full argv used to start the Claude ACP adapter. */
  claudeCommand: string[];
  /** Executable used to start pi in RPC mode. */
  piCommand: string[];
  /** Executable of the Antigravity CLI. */
  agyCommand: string[];
  /** argv that starts TRAE CLI as an ACP server. */
  traexCommand: string[];
  /** argv that starts Codex's app server. */
  codexCommand: string[];
  /** Executable that runs in a web terminal. */
  termShell: string | null;
  /** Directory of the built web UI, served at `/` when present. */
  webDir: string | null;
  /** Unix socket a hub on another machine reaches this daemon through, over SSH. Null when turned off. */
  socket: string | null;
  /** argv that starts OpenSSH, for reaching the daemons of other machines. */
  sshCommand: string[];
}

/**
 * Where a daemon's socket is, under the home directory, unless RAH_SOCKET says otherwise. A hub
 * looks for it there on a machine it is given, so it is a fixed place and not an XDG one: the
 * environment of an `ssh host command` is not the one the daemon was started in.
 */
export const SOCKET_IN_HOME = '.local/state/remote-agent-hub/daemon.sock';

/**
 * Loads `.env` from the current directory if it exists, without overriding
 * variables that are already set in the environment.
 */
export function loadDotEnv(file = process.env.RAH_ENV_FILE ?? '.env'): void {
  const path = resolve(file);
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** Resolves the Claude ACP adapter from this package's own dependencies. */
function defaultClaudeCommand(): string[] {
  const require = createRequire(import.meta.url);
  const pkgJson = require.resolve('@agentclientprotocol/claude-agent-acp/package.json');
  const pkg = JSON.parse(readFileSync(pkgJson, 'utf8')) as { bin?: Record<string, string> };
  const rel = pkg.bin?.['claude-agent-acp'];
  if (!rel) throw new Error('claude-agent-acp package has no bin entry');
  return [process.execPath, join(dirname(pkgJson), rel)];
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.RAH_TOKEN ?? '';
  if (token.length < 16) {
    throw new Error('RAH_TOKEN is missing or shorter than 16 characters. Set it in .env (see .env.example).');
  }

  const dataDir = resolve(env.RAH_DATA_DIR || './data');

  const workdirs = splitList(env.RAH_WORKDIRS).map((d) => (isAbsolute(d) ? d : resolve(d)));

  const claudeCommand = env.RAH_CLAUDE_ACP_BIN ? [env.RAH_CLAUDE_ACP_BIN] : defaultClaudeCommand();
  const piCommand = [env.RAH_PI_BIN || 'pi'];
  const agyCommand = [env.RAH_AGY_BIN || 'agy'];
  const traexCommand = [env.RAH_TRAEX_BIN || 'traex', 'acp', 'serve'];
  const codexCommand = [env.RAH_CODEX_BIN || 'codex', 'app-server'];
  const termShell = env.RAH_TERM_SHELL || null;

  // Serve the built UI from the sibling web package when it exists; RAH_WEB_DIR overrides.
  const bundledWebDir = fileURLToPath(new URL('../../web/dist', import.meta.url));
  const webDirEnv = env.RAH_WEB_DIR;
  const webDir = webDirEnv ? resolve(webDirEnv) : existsSync(bundledWebDir) ? bundledWebDir : null;

  const socketEnv = env.RAH_SOCKET?.trim();
  const socket = socketEnv === 'off' ? null : socketEnv ? resolve(socketEnv) : join(env.HOME || homedir(), SOCKET_IN_HOME);

  return {
    host: env.RAH_HOST || '127.0.0.1',
    port: Number(env.RAH_PORT || 8787),
    token,
    dataDir,
    workdirs,
    claudeCommand,
    piCommand,
    agyCommand,
    traexCommand,
    codexCommand,
    termShell,
    webDir,
    socket,
    sshCommand: [env.RAH_SSH_BIN || 'ssh'],
  };
}
