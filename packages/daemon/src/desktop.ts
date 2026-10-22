import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';

/**
 * The machine's Linux desktop, as a VNC server already shows it. The daemon starts no desktop and
 * sets no DISPLAY for agents: it finds a VNC server on this machine and passes a page's WebSocket
 * through to it, the job websockify does for noVNC. Like the terminal, it is a tool for the person.
 */

export interface DesktopTarget {
  host: string;
  port: number;
}

/** Where VNC servers listen by convention: 5900 + display number. Displays :0 to :9 are looked at. */
const DEFAULT_PORTS = Array.from({ length: 10 }, (_, i) => 5900 + i);
const PROBE_TIMEOUT_MS = 500;
/** A status check and the connection right after it should not probe twice. */
const CACHE_MS = 5_000;
/** Above this much unsent output, the VNC side waits for the page to catch up. */
const HIGH_WATER = 4 * 1024 * 1024;

/** How long a desktop ticket opens a connection. It is used at once, by the page that asked. */
export const DESKTOP_TICKET_S = 60;

/** `RAH_DESKTOP_VNC`: unset looks on this machine, `off` turns the desktop off, `host:port` names the server. */
export function parseDesktopSetting(value: string | undefined): DesktopTarget[] | null {
  const v = value?.trim();
  if (!v) return DEFAULT_PORTS.map((port) => ({ host: '127.0.0.1', port }));
  if (v === 'off') return null;
  const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(v);
  if (!m || Number(m[3]) > 65535) throw new Error(`RAH_DESKTOP_VNC must be host:port or off, not ${v}`);
  return [{ host: m[1] ?? m[2], port: Number(m[3]) }];
}

/** Whether a VNC server answers there: an RFB server speaks first, with its protocol version. */
export function probeRfb(target: DesktopTarget, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((done) => {
    let got = Buffer.alloc(0);
    const socket = connect(target.port, target.host);
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      done(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on('data', (chunk) => {
      got = Buffer.concat([got, chunk]);
      if (got.length >= 12) finish(/^RFB \d{3}\.\d{3}\n$/.test(got.subarray(0, 12).toString('latin1')));
    });
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
  });
}

function signature(secret: string, path: string, exp: number, nonce: string): string {
  return createHmac('sha256', secret).update(`desktop\0${path}\0${exp}\0${nonce}`).digest('base64url');
}

export class Desktop {
  private readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  private readonly targets: DesktopTarget[] | null;
  private cached: { at: number; target: DesktopTarget | null } | null = null;
  /** Tickets already used, until they expire: each opens one connection. */
  private readonly spent = new Map<string, number>();
  private readonly sockets = new Set<Socket>();

  constructor(opts: { targets: DesktopTarget[] | null; now?: () => number }) {
    this.targets = opts.targets;
    if (opts.now) this.now = opts.now;
  }

  private now = () => Date.now();

  /** The first VNC server that answers, in the order looked at; null when there is none. */
  async find(): Promise<DesktopTarget | null> {
    if (!this.targets) return null;
    if (this.cached && this.now() - this.cached.at < CACHE_MS) return this.cached.target;
    const found = await Promise.all(this.targets.map((t) => probeRfb(t)));
    const target = this.targets[found.indexOf(true)] ?? null;
    this.cached = { at: this.now(), target };
    return target;
  }

  /** A short-lived signed query for a WebSocket to `path`: a browser's WebSocket cannot send a token. */
  ticket(secret: string, path: string): string {
    const exp = Math.floor(this.now() / 1000) + DESKTOP_TICKET_S;
    // Two tickets asked for in the same second differ: each is spent on its own.
    const nonce = randomBytes(9).toString('base64url');
    return new URLSearchParams({ exp: String(exp), n: nonce, sig: signature(secret, path, exp, nonce) }).toString();
  }

  /** Whether the query opens `path`. A ticket opens one connection and is spent. */
  checkTicket(secret: string, path: string, exp: string | null, nonce: string | null, sig: string | null): boolean {
    const now = this.now();
    for (const [used, until] of this.spent) if (until * 1000 < now) this.spent.delete(used);
    if (!exp || !nonce || !sig || !/^\d+$/.test(exp) || Number(exp) * 1000 < now || this.spent.has(sig)) return false;
    const want = Buffer.from(signature(secret, path, Number(exp), nonce));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
    this.spent.set(sig, Number(exp));
    return true;
  }

  /** Turns the upgrade into a WebSocket and joins it to the VNC server, byte for byte both ways. */
  async accept(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const target = await this.find();
    if (!target) return refuse(socket, 404, 'no desktop on this machine');
    const vnc = connect(target.port, target.host);
    vnc.setNoDelay(true);
    // A server gone between the probe and now: the page gets its socket closed, not a crash.
    vnc.on('error', () => socket.destroy());
    this.sockets.add(vnc);
    vnc.on('close', () => this.sockets.delete(vnc));
    this.wss.handleUpgrade(req, socket, head, (ws) => bridge(ws, vnc));
  }

  /** Ends every open connection. */
  dispose(): void {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
  }
}

function bridge(ws: WebSocket, vnc: Socket): void {
  ws.binaryType = 'nodebuffer';
  vnc.on('data', (chunk) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(chunk, { binary: true }, () => {
      if (vnc.isPaused() && ws.bufferedAmount < HIGH_WATER / 2) vnc.resume();
    });
    if (ws.bufferedAmount > HIGH_WATER) vnc.pause();
  });
  ws.on('message', (data: Buffer) => {
    if (!vnc.write(data)) ws.pause();
  });
  vnc.on('drain', () => ws.resume());
  vnc.on('close', () => ws.close());
  vnc.on('error', () => ws.close(1011, 'desktop connection failed'));
  ws.on('close', () => vnc.destroy());
  ws.on('error', () => vnc.destroy());
}

/** Answers an upgrade that is not taken, and closes it. */
export function refuse(socket: Duplex, status: number, message: string): void {
  const reason = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 502: 'Bad Gateway' }[status] ?? 'Error';
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
}
