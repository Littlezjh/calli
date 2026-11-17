import { execFile } from 'node:child_process';
import { cp, readFile, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { startCodeLogin } from './code-login.js';
import type { LoginSession } from './types.js';

// A new subscription must not inherit an API key or another account's OAuth override.
const AUTH_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];

export async function copyClaudeAccount(source: string, configFile: string, target: string, env: Record<string, string>): Promise<Record<string, string>> {
  // Copy portable configuration only. Credentials, histories, caches and project trust stay put.
  for (const name of ['CLAUDE.md', 'skills', 'agents', 'commands', 'hooks', 'settings.json', 'settings.local.json']) {
    const path = join(source, name);
    try { await lstat(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (name.startsWith('settings.')) {
      const settings = JSON.parse(await readFile(path, 'utf8'));
      delete settings.apiKeyHelper;
      delete settings.forceLoginOrgUUID;
      delete settings.forceLoginMethod;
      for (const key of [...AUTH_ENV, 'CLAUDE_CONFIG_DIR']) if (settings.env) delete settings.env[key];
      await writeFile(join(target, name), JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
    } else {
      // Materialize symlinks so editing the new account cannot write through into the source.
      await cp(path, join(target, name), { recursive: true, dereference: true, force: false, errorOnExist: true });
    }
  }
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(await readFile(configFile, 'utf8')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Always create this file: an empty account must not fall back to the original global config.
  await writeFile(join(target, '.claude.json'), JSON.stringify({ mcpServers: config.mcpServers ?? {} }, null, 2) + '\n', { mode: 0o600 });
  return { ...env, ...Object.fromEntries(AUTH_ENV.map(key => [key, ''])), CLAUDE_CONFIG_DIR: target };
}

/** The native CLI owns OAuth, PKCE and credential storage. */
export function startClaudeLogin(binary: string, configDir: string, extraEnv: Record<string, string>, onSuccess: (account?: string) => Promise<void>, timeoutMs = 10 * 60_000): LoginSession {
  const env = { ...process.env, ...extraEnv, CLAUDE_CONFIG_DIR: configDir, BROWSER: 'true' };
  return startCodeLogin([binary, 'auth', 'login', '--claudeai'], env,
    url => ['claude.ai', 'claude.com', 'console.anthropic.com', 'platform.claude.com'].includes(url.hostname) && url.pathname.endsWith('/oauth/authorize'),
    () => new Promise((resolve, reject) => {
      execFile(binary, ['auth', 'status'], { env, timeout: 15_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
        try {
          const status = JSON.parse(stdout);
          if (error || status.loggedIn !== true) throw new Error('login verification failed');
          resolve(typeof status.email === 'string' ? status.email : undefined);
        } catch (error) { reject(error); }
      });
    }), onSuccess, timeoutMs);
}
