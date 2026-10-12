import { useCallback, useEffect, useState } from 'react';
import { Api, type HostFailure, type HostInfo } from './api';

const HOST_KEY = 'rah.host';

/** The machine this device was last looking at; null is the hub's own. */
export function loadHost(): string | null {
  try {
    return localStorage.getItem(HOST_KEY) || null;
  } catch {
    return null;
  }
}

export function saveHost(id: string | null): void {
  try {
    if (id) localStorage.setItem(HOST_KEY, id);
    else localStorage.removeItem(HOST_KEY);
  } catch {
    // Not remembered, still switched.
  }
}

export const HOST_STATUS: Record<HostInfo['status'], string> = { online: '在线', connecting: '连接中', offline: '离线' };

/**
 * Why a machine cannot be reached, said so that it is clear what to do about it. The hub signs in
 * as itself, with nobody to answer a prompt, so most of these are fixed on the hub's machine.
 */
export function hostProblem(code: HostFailure | undefined, target: string): string {
  switch (code) {
    case 'no_ssh':
      return 'hub 所在的机器上没有装 ssh。';
    case 'host_key':
      return `hub 还不认识这台机器的主机密钥。在 hub 所在的机器上运行一次 ssh ${target}，确认指纹后再试。`;
    case 'auth':
      return `hub 登录不上这台机器。它要不输密码就能登录：先在 hub 所在的机器上确认 ssh ${target} 能直接进去。`;
    case 'unreachable':
      return '连不到这台机器：名字解析不了、网络不通，或者超时了。';
    case 'daemon_missing':
      return '登录上了，但那台机器上的 Limi 没有应答。在那台机器上装好并启动它；已经在运行的话，检查它的 sshd 是否允许转发。';
    case 'forward_denied':
      return '那台机器的 sshd 不允许转发连接。';
    default:
      return 'ssh 没连上。';
  }
}

// Switching machines remounts the app; what was known about the machines carries over, so the
// switcher does not blink out and in.
let known: HostInfo[] = [];
let knownLoaded = false;

/** How often the machines are asked about while the page is in front. */
const HOSTS_POLL_MS = 10_000;

/**
 * The hub's other machines, kept fresh. `loaded` is false until the hub has answered once: until
 * then nothing can be said about a machine, not even that it is gone.
 */
export function useHosts(token: string): { hosts: HostInfo[]; loaded: boolean; reload: () => Promise<void> } {
  const [state, setState] = useState({ hosts: known, loaded: knownLoaded });
  const reload = useCallback(async () => {
    if (!token) return;
    try {
      const hosts = await new Api(token).hosts();
      const changed = !knownLoaded || JSON.stringify(hosts) !== JSON.stringify(known);
      known = hosts;
      knownLoaded = true;
      if (changed) setState({ hosts, loaded: true });
    } catch {
      // A hub that cannot say keeps what the page last heard.
    }
  }, [token]);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => {
      if (!document.hidden) void reload();
    }, HOSTS_POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reload]);

  return { ...state, reload };
}
