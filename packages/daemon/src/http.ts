import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { ApprovalDecision } from './adapters/types.js';
import type { AgentRegistry } from './agents.js';
import type { StoredEvent } from './events.js';
import { HttpError } from './errors.js';
import type { HostRegistry } from './hosts.js';
import { checkGrant, cookieValue, makeGrant, PREVIEW_COOKIE, readPreviewFile } from './preview.js';
import type { TerminalEvent, TerminalManager } from './terminals.js';
import type { ThreadManager } from './threads.js';
import { isWithinWorkdirs } from './workdirs.js';
import { listProjectDirectories } from './project-directories.js';

export interface HttpDeps {
  manager: ThreadManager;
  /** Agent instances beyond the built-in ones. Optional so simple setups and tests need none. */
  registry?: AgentRegistry;
  /** Web terminals. Optional so deployments and tests can run without them. */
  terminals?: TerminalManager;
  /** Other machines this hub shows. Optional so simple setups and tests need none. */
  hosts?: HostRegistry;
  /**
   * Requests need no token: the server listens on a socket only this user can open, and a hub
   * reaches it over SSH. Such a server shows this machine only, never the machines added to it.
   */
  trusted?: boolean;
  token: string;
  webDir: string | null;
  version: string;
  /**
   * The port previews are served on. The iframe needs an origin of its own: on the app's port it
   * would be either opaque (and the browser would block its subresources) or same-origin with
   * the app (and its pages could reach into it). Null when no preview port could be opened.
   */
  previewPort?: number | null;
}

const MAX_BODY = 1024 * 1024;
/** Turns can carry images as base64, so they get a larger limit than other requests. */
const MAX_TURN_BODY = 45 * 1024 * 1024;
// Everything that changes what the thread list shows: a thread's state, and whether it is waiting for approval.
const GLOBAL_EVENT_TYPES = new Set([
  'thread.created',
  'thread.updated',
  'turn.started',
  'turn.done',
  'turn.error',
  'approval.request',
  'approval.resolved',
  'todo.updated',
]);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/** Constant-time check of a bearer token. Hashing first makes the length comparison safe. */
export function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  // Thread logs reach megabytes of JSON; a browser that accepts gzip gets many times less to
  // transfer. `res.req` is the request this response belongs to.
  const accepts = String(res.req?.headers['accept-encoding'] ?? '');
  if (accepts.includes('gzip') && payload.length > 1024) {
    const gzipped = gzipSync(payload);
    if (gzipped.length < payload.length) {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Encoding': 'gzip',
        Vary: 'Accept-Encoding',
        'Cache-Control': 'no-store',
      });
      res.end(gzipped);
      return;
    }
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof HttpError) {
    sendJson(res, err.status, { ...err.details, error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : 'internal error';
  console.error('[http]', err);
  sendJson(res, 500, { error: message });
}

async function readJson(req: IncomingMessage, limit = MAX_BODY): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

function openSse(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
}

function writeEvent(res: ServerResponse, ev: StoredEvent): void {
  res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
}

/** Terminal frames carry no seq, so they get their own simpler SSE writer. */
function writeTerminalEvent(res: ServerResponse, ev: TerminalEvent): void {
  res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
}

function serveStatic(res: ServerResponse, webDir: string, urlPath: string): void {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.slice(1));
  let file = normalize(join(webDir, rel));
  if (!file.startsWith(webDir + sep) && file !== webDir) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(webDir, 'index.html'); // SPA fallback
  if (!existsSync(file)) {
    res.writeHead(404).end('web UI not built');
    return;
  }
  // The build gives files under assets/ content-hashed names, so they are safe to cache forever.
  // Everything else — index.html above all — must be revalidated, or a phone keeps running the
  // build it loaded and never even hears about a newer one.
  const immutable = file.startsWith(join(webDir, 'assets') + sep);
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}

export function createHttpServer(deps: HttpDeps): Server {
  const { manager, registry, terminals, hosts, trusted, token, webDir, version } = deps;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (!path.startsWith('/api/')) {
      if (webDir && (method === 'GET' || method === 'HEAD')) return serveStatic(res, webDir, path);
      res.writeHead(404).end();
      return;
    }

    if (path === '/api/health') return sendJson(res, 200, { ok: true, version });

    const auth = req.headers.authorization ?? '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
    // One route carries its own auth instead: preview files are fetched by an iframe, which cannot
    // send headers, so it opens with a short-lived signature verified inside the route.
    const signedFileRoute = /^\/api\/threads\/[^/]+\/files\//.test(path);
    if (!trusted && !signedFileRoute && !tokenMatches(bearer, token)) return sendJson(res, 401, { error: 'unauthorized' });

    const parts = path.split('/').filter(Boolean); // ['api', ...]

    // Other machines. One level only: a machine reached through its socket does not pass requests on.
    if (parts[1] === 'hosts' && hosts && !trusted) {
      // GET /api/hosts, POST /api/hosts { target, label? }
      if (path === '/api/hosts') {
        if (method === 'GET') return sendJson(res, 200, hosts.list());
        if (method === 'POST') return sendJson(res, 201, await hosts.add(await readJson(req)));
      }
      // GET /api/hosts/candidates: aliases in this user's ssh config that could be added
      if (method === 'GET' && path === '/api/hosts/candidates') return sendJson(res, 200, hosts.candidates());
      // DELETE /api/hosts/:id
      if (method === 'DELETE' && parts[2] && !parts[3]) {
        hosts.remove(parts[2]);
        res.writeHead(204).end();
        return;
      }
      // POST /api/hosts/:id/reconnect: try now, not when the next retry is due
      if (method === 'POST' && parts[2] && parts[3] === 'reconnect' && !parts[4]) {
        return sendJson(res, 200, await hosts.reconnect(parts[2]));
      }
      // /api/hosts/:id/proxy/...: the same API, answered by that machine's daemon
      if (parts[2] && parts[3] === 'proxy' && parts[4]) {
        if (parts[4] === 'hosts') throw new HttpError(400, 'a machine does not pass requests on to others');
        const rest = path.slice(`/api/hosts/${parts[2]}/proxy/`.length);
        return hosts.proxy(decodeURIComponent(parts[2]), `/api/${rest}${url.search}`, req, res);
      }
    }

    // GET /api/agents
    if (method === 'GET' && path === '/api/agents') return sendJson(res, 200, await manager.listAgents());

    // GET /api/agents/discover: CLIs on PATH that look like another copy of a known agent
    if (method === 'GET' && path === '/api/agents/discover') {
      if (!registry) throw new HttpError(404, 'this daemon has no agent registry');
      return sendJson(res, 200, await registry.discover());
    }

    // GET /api/agents/accounts/discover: signed-in accounts of multi-account agents, ready to link
    if (method === 'GET' && path === '/api/agents/accounts/discover') {
      if (!registry) throw new HttpError(404, 'this daemon has no agent registry');
      return sendJson(res, 200, await registry.discoverAccounts());
    }

    // POST /api/agents: add an instance (another CLI, another account)
    if (method === 'POST' && path === '/api/agents') {
      if (!registry) throw new HttpError(404, 'this daemon has no agent registry');
      const body = await readJson(req);
      return sendJson(res, 201, await registry.add(body));
    }

    // GET /api/agents/:id/sessions: conversations the agent already has, for importing
    if (method === 'GET' && parts[0] === 'api' && parts[1] === 'agents' && parts[2] && parts[3] === 'sessions') {
      return sendJson(res, 200, await manager.listAgentSessions(parts[2]));
    }

    // GET /api/agents/:id/quota: plan usage, read outside any session and cached briefly.
    // ?refresh=1 skips the cache: the dashboard's refresh button means "ask again now".
    if (method === 'GET' && parts[0] === 'api' && parts[1] === 'agents' && parts[2] && parts[3] === 'quota') {
      return sendJson(res, 200, await manager.agentQuota(parts[2], url.searchParams.get('refresh') === '1'));
    }

    // GET /api/agents/:id/commands
    if (method === 'GET' && parts[0] === 'api' && parts[1] === 'agents' && parts[2] && parts[3] === 'commands') {
      return sendJson(res, 200, await manager.listCommands(parts[2], url.searchParams.get('cwd') ?? undefined));
    }

    // GET /api/agents/:id/models
    if (method === 'GET' && parts[0] === 'api' && parts[1] === 'agents' && parts[2] && parts[3] === 'models') {
      return sendJson(res, 200, await manager.listModels(parts[2]));
    }

    // Skills: what each agent instance has, where it came from, and how a copy moves between
    // agents and machines. The page drives cross-machine sync itself, through these same routes.
    if (parts[1] === 'skills' && !parts[2]) {
      if (method === 'GET') return sendJson(res, 200, manager.skills.listing());
      if (method === 'DELETE') {
        manager.skills.remove(url.searchParams.get('name') ?? '', url.searchParams.get('path'));
        res.writeHead(204).end();
        return;
      }
    }
    // GET /api/skills/detail?name=&path=: one skill and its SKILL.md, for the page to read
    if (method === 'GET' && parts[1] === 'skills' && parts[2] === 'detail' && !parts[3]) {
      return sendJson(res, 200, manager.skills.detail(url.searchParams.get('name') ?? '', url.searchParams.get('path')));
    }
    // GET /api/skills/export?name=&path=: a skill packed to carry to another machine
    if (method === 'GET' && parts[1] === 'skills' && parts[2] === 'export' && !parts[3]) {
      return sendJson(res, 200, manager.skills.payload(url.searchParams.get('name') ?? '', url.searchParams.get('path')));
    }
    // POST /api/skills/install { from?: { name, path }, skill?: payload, targets: [agent], overwrite? }
    if (method === 'POST' && parts[1] === 'skills' && parts[2] === 'install' && !parts[3]) {
      return sendJson(res, 200, await manager.skills.install(await readJson(req, 24 * 1024 * 1024)));
    }

    // GET /api/config: the project roots, and whether threads can work outside a project
    if (method === 'GET' && path === '/api/config') return sendJson(res, 200, manager.workdirsConfig());

    // Browse candidate project folders without widening file access or allowed working directories.
    if (method === 'GET' && path === '/api/project-directories') {
      return sendJson(res, 200, listProjectDirectories(manager.workdirsConfig().workdirs, url.searchParams.get('path') ?? undefined));
    }

    // POST /api/workdirs { path }, DELETE /api/workdirs?path=: project roots added from the page
    if (path === '/api/workdirs') {
      if (method === 'POST') return sendJson(res, 200, manager.addWorkdir((await readJson(req))?.path));
      if (method === 'DELETE') return sendJson(res, 200, manager.removeWorkdir(url.searchParams.get('path')));
    }

    // POST /api/projects { parent, name, git }: a new project folder
    if (method === 'POST' && path === '/api/projects') return sendJson(res, 201, await manager.createProject((await readJson(req)) ?? {}));

    // GET /api/directories?path=...
    if (method === 'GET' && path.startsWith('/api/directories')) {
      const dirPath = url.searchParams.get('path') ?? '';
      return sendJson(res, 200, listDirectory(manager.allowedWorkdirs, dirPath));
    }

    // GET /api/directory-tree?root=...
    if (method === 'GET' && path.startsWith('/api/directory-tree')) {
      const root = url.searchParams.get('root') ?? '';
      const maxDepth = Number(url.searchParams.get('maxDepth') ?? 3) || 3;
      return sendJson(res, 200, buildDirectoryTree(manager.allowedWorkdirs, root, maxDepth));
    }

    // POST /api/threads/import: turn an existing agent session into a thread
    if (method === 'POST' && path === '/api/threads/import') {
      const body = await readJson(req);
      return sendJson(res, 201, await manager.importSession({ agent: body.agent, sessionId: body.sessionId }));
    }

    // GET /api/worktree-options?cwd=: whether a new thread there could start in a git worktree
    if (method === 'GET' && path === '/api/worktree-options') {
      return sendJson(res, 200, await manager.worktreeOptions(url.searchParams.get('cwd')));
    }

    // GET /api/threads, POST /api/threads
    if (path === '/api/threads') {
      if (method === 'GET') {
        return sendJson(res, 200, manager.listThreads({ archived: url.searchParams.get('archived') === '1' }));
      }
      if (method === 'POST') {
        const body = await readJson(req);
        return sendJson(
          res,
          201,
          await manager.createThread({
            agent: body.agent,
            cwd: body.cwd,
            title: body.title,
            permissionMode: body.permissionMode,
            model: body.model,
            effort: body.effort,
            sectionId: body.sectionId,
            worktree: body.worktree === true,
            scratch: body.scratch === true,
          }),
        );
      }
    }

    // Sections: user-made groups for the sidebar.
    if (path === '/api/sections') {
      if (method === 'GET') return sendJson(res, 200, manager.listSections());
      if (method === 'POST') return sendJson(res, 201, manager.createSection((await readJson(req)).name));
    }
    if (parts[1] === 'sections' && parts[2] && !parts[3]) {
      if (method === 'PATCH') return sendJson(res, 200, manager.renameSection(parts[2], (await readJson(req)).name));
      if (method === 'DELETE') {
        manager.deleteSection(parts[2]);
        res.writeHead(204).end();
        return;
      }
    }

    // Plan page: the user's own long-lived list, linked to threads.
    if (path === '/api/todos') {
      if (method === 'GET') return sendJson(res, 200, manager.listTodos());
      if (method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 201, manager.createTodo(body.text, body.parentId));
      }
    }
    if (parts[1] === 'todos' && parts[2] && !parts[3]) {
      if (method === 'PATCH') {
        const body = await readJson(req);
        return sendJson(res, 200, manager.updateTodo(parts[2], { text: body.text, done: body.done }));
      }
      if (method === 'DELETE') {
        manager.deleteTodo(parts[2]);
        res.writeHead(204).end();
        return;
      }
    }
    if (parts[1] === 'todos' && parts[2] && parts[3] === 'move' && method === 'POST') {
      const body = await readJson(req);
      manager.moveTodo(parts[2], { parentId: body.parentId, before: body.before });
      res.writeHead(204).end();
      return;
    }
    if (parts[1] === 'todos' && parts[2] && parts[3] === 'threads') {
      if (method === 'POST') {
        manager.linkTodoThread(parts[2], (await readJson(req)).threadId);
        res.writeHead(204).end();
        return;
      }
      if (method === 'DELETE') {
        manager.unlinkTodoThread(parts[2], url.searchParams.get('threadId'));
        res.writeHead(204).end();
        return;
      }
    }

    // Web terminals: a real PTY each, output over SSE and keystrokes over POST.
    if (terminals) {
      if (path === '/api/terminals') {
        if (method === 'GET') return sendJson(res, 200, terminals.list());
        if (method === 'POST') {
          const body = await readJson(req);
          return sendJson(res, 201, terminals.create(body.cwd));
        }
      }
      if (parts[1] === 'terminals' && parts[2] && !parts[3]) {
        if (method === 'DELETE') {
          terminals.kill(parts[2]);
          res.writeHead(204).end();
          return;
        }
      }
      if (parts[1] === 'terminals' && parts[2] && parts[3] === 'input' && method === 'POST') {
        const body = await readJson(req);
        terminals.input(parts[2], body.data);
        res.writeHead(204).end();
        return;
      }
      if (parts[1] === 'terminals' && parts[2] && parts[3] === 'size' && method === 'POST') {
        const body = await readJson(req);
        terminals.resize(parts[2], body.cols, body.rows);
        res.writeHead(204).end();
        return;
      }
      if (method === 'GET' && parts[1] === 'terminals' && parts[2] && parts[3] === 'stream') {
        terminals.get(parts[2]); // 404 before opening the stream
        openSse(res);
        // Synchronous replay: no frame can slip in between the backlog and the subscription.
        const off = terminals.subscribe(parts[2], (ev) => writeTerminalEvent(res, ev));
        return finishStream(req, res, off);
      }
    }

    // GET /api/stream: lightweight stream of thread-list changes.
    if (method === 'GET' && path === '/api/stream') {
      openSse(res);
      const off = manager.subscribe((ev) => {
        if (GLOBAL_EVENT_TYPES.has(ev.type)) writeEvent(res, ev);
      });
      return finishStream(req, res, off);
    }

    // /api/threads/:id ...
    if (parts[0] === 'api' && parts[1] === 'threads' && parts[2]) {
      const threadId = parts[2];
      const sub = parts[3];

      if (sub === 'coordination') {
        manager.threadView(threadId);
        const collaboration = manager.coordination;
        if (!collaboration) throw new HttpError(501, '此 daemon 尚未启用协作');
        if (method === 'GET') return sendJson(res, 200, collaboration.view(threadId));
        if (method === 'POST') {
          const body = await readJson(req);
          if (body.action === 'resume') return sendJson(res, 200, await collaboration.resume(threadId));
          if (body.action === 'stop') { await manager.cancelTurn(threadId); return sendJson(res, 200, collaboration.view(threadId)); }
          return sendJson(res, 200, await collaboration.enable(threadId, body));
        }
      }
      if (method === 'GET' && !sub) return sendJson(res, 200, manager.threadView(threadId));

      if (method === 'DELETE' && !sub) {
        await manager.deleteThread(threadId, {
          agentSession: url.searchParams.get('agentSession') === '1',
          worktree: url.searchParams.get('worktree') === '1',
          force: url.searchParams.get('force') === '1',
        });
        res.writeHead(204).end();
        return;
      }

      if (method === 'PATCH' && !sub) {
        const body = await readJson(req);
        return sendJson(
          res,
          200,
          await manager.updateThread(threadId, {
            title: body.title,
            pinned: body.pinned,
            permissionMode: body.permissionMode,
            model: body.model,
            effort: body.effort,
            archived: body.archived,
            sectionId: body.sectionId,
            unread: body.unread,
          }),
        );
      }

      if (method === 'GET' && sub === 'events') {
        // ?tail: the newest turns, what a reopened page renders first. ?before=S: the turns just
        // before what the page has. Both begin at a turn's start and merge streamed fragments.
        // ?all: the whole log, fragments merged, for copying a conversation out.
        // Plain ?after=S is the log as stored, one page at a time.
        if (url.searchParams.has('all')) return sendJson(res, 200, manager.listEventsSince(threadId, 0));
        if (url.searchParams.has('tail')) return sendJson(res, 200, manager.listEventsPage(threadId));
        const before = Number(url.searchParams.get('before') ?? 0) || 0;
        if (before > 0) return sendJson(res, 200, manager.listEventsPage(threadId, before));
        const after = Number(url.searchParams.get('after') ?? 0) || 0;
        return sendJson(res, 200, manager.listEvents(threadId, after));
      }

      if (method === 'GET' && sub === 'stream') {
        const after = Number(url.searchParams.get('after') ?? 0) || 0;
        manager.getThread(threadId); // 404 before opening the stream
        openSse(res);
        // Synchronous: no event can slip in between the backlog and the subscription.
        for (const ev of manager.listEventsSince(threadId, after)) writeEvent(res, ev);
        const off = manager.subscribe((ev) => {
          if (ev.threadId === threadId) writeEvent(res, ev);
        });
        return finishStream(req, res, off);
      }

      if (method === 'POST' && sub === 'handover-thread') {
        const body = await readJson(req);
        return sendJson(res, 201, await manager.createHandoverThread(threadId, body.agent));
      }

      if (method === 'POST' && sub === 'handover') {
        // Asks the thread's agent to write a summary for another agent; the GET reads it back.
        const body = await readJson(req);
        return sendJson(res, 202, await manager.startHandover(threadId, String(body.target ?? '')));
      }
      if (method === 'GET' && sub === 'handover') {
        return sendJson(
          res,
          200,
          await manager.handoverSummary(threadId, url.searchParams.get('turn'), url.searchParams.get('target') ?? undefined),
        );
      }

      if (method === 'POST' && sub === 'turns') {
        const body = await readJson(req, MAX_TURN_BODY);
        const text = manager.coordination?.mentionText(threadId, body.text, body.mentions) ?? body.text;
        return sendJson(res, 202, await manager.startTurn(threadId, { text, images: body.images, queue: body.queue }));
      }

      // DELETE /api/threads/:id/queue/:queuedId: take back a message that is waiting; it comes back
      // whole (text and images), for putting it in the box to edit
      if (method === 'DELETE' && sub === 'queue' && parts[4] && !parts[5]) {
        return sendJson(res, 200, manager.removeQueued(threadId, parts[4]));
      }

      // POST /api/threads/:id/queue/:queuedId/now: interrupt the running turn and send this one next
      if (method === 'POST' && sub === 'queue' && parts[4] && parts[5] === 'now') {
        await manager.sendQueuedNow(threadId, parts[4]);
        res.writeHead(204).end();
        return;
      }

      // GET /api/threads/:id/files?path=: an image the agent made or mentioned. (Without a
      // sub-path: /files/<path> below is the signed preview route of the same name.)
      if (method === 'GET' && sub === 'files' && !parts[4]) {
        const file = manager.getThreadImage(threadId, url.searchParams.get('path'));
        res.writeHead(200, {
          'Content-Type': file.mimeType,
          'Content-Length': file.size,
          // Unlike attachments, these are the agent's working files and can change.
          'Cache-Control': 'private, max-age=30',
          'X-Content-Type-Options': 'nosniff',
          // An SVG is a document that can carry scripts. Opened on its own it runs none of them
          // and reaches nothing of the hub's.
          'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
        });
        createReadStream(file.path).pipe(res);
        return;
      }

      // GET /api/threads/:id/tree?path=: one folder of the thread's directory, for the file browser
      if (method === 'GET' && sub === 'tree') {
        return sendJson(res, 200, await manager.listThreadDir(threadId, url.searchParams.get('path')));
      }

      // GET /api/threads/:id/find?q=: files in the thread directory whose path matches, for the browser's filter
      if (method === 'GET' && sub === 'find') {
        return sendJson(res, 200, await manager.findThreadFiles(threadId, url.searchParams.get('q') ?? ''));
      }

      // GET /api/threads/:id/text?path=: a text file's contents, for the file viewer (read only)
      if (method === 'GET' && sub === 'text') {
        return sendJson(res, 200, manager.readThreadText(threadId, url.searchParams.get('path')));
      }

      // GET /api/threads/:id/preview-link?path=: where the preview of this file lives, plus the
      // short-lived cookie that opens it. The iframe loads from the preview port and the cookie
      // rides along on every request the page makes under its own path, signature or not.
      if (method === 'GET' && sub === 'preview-link') {
        const { rel } = manager.threadFile(threadId, url.searchParams.get('path'));
        if (!deps.previewPort) throw new HttpError(503, 'the preview port is not available on this daemon');
        const host = (req.headers.host ?? '').replace(/:\d+$/, '');
        if (!host) throw new HttpError(400, 'the request names no host');
        const grant = makeGrant(token, threadId);
        res.setHeader(
          'Set-Cookie',
          `${PREVIEW_COOKIE}=${grant.value}; Path=/api/threads/${threadId}/files; Max-Age=${grant.maxAge}; HttpOnly; SameSite=Lax`,
        );
        const file = rel.split('/').map(encodeURIComponent).join('/');
        return sendJson(res, 200, { url: `http://${host}:${deps.previewPort}/api/threads/${threadId}/files/${file}` });
      }

      // GET /api/threads/:id/files/<path>: the file itself, on the preview port. The cookie from
      // preview-link is the auth here — subresources of a page carry no query string, but a
      // cookie scoped to this thread's path comes along on its own.
      if (method === 'GET' && sub === 'files' && parts[4]) {
        const rel = parts
          .slice(4)
          .map((p) => {
            try {
              return decodeURIComponent(p);
            } catch {
              return p;
            }
          })
          .join('/');
        checkGrant(token, threadId, cookieValue(req.headers.cookie, PREVIEW_COOKIE));
        const { real } = manager.threadFile(threadId, rel);
        const { body, contentType } = readPreviewFile(real);
        res.writeHead(200, {
          'Content-Type': contentType,
          'X-Content-Type-Options': 'nosniff',
          // Previews are pages an agent may rewrite any minute: what is shown is what is on disk.
          'Cache-Control': 'no-store',
          'Content-Length': body.length,
        });
        res.end(body);
        return;
      }

      // GET /api/threads/:id/attachments/:attachmentId
      if (method === 'GET' && sub === 'attachments' && parts[4]) {
        const file = manager.getAttachment(threadId, parts[4]);
        res.writeHead(200, {
          'Content-Type': file.mimeType,
          'Content-Length': file.size,
          // Attachments never change once stored. "private" keeps them out of shared caches.
          'Cache-Control': 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
        });
        createReadStream(file.path).pipe(res);
        return;
      }

      if (method === 'POST' && sub === 'sync') {
        return sendJson(res, 200, await manager.syncThread(threadId));
      }

      if (method === 'GET' && sub === 'fork-options') return sendJson(res, 200, await manager.forkOptions(threadId));

      if (method === 'POST' && sub === 'fork') {
        // An empty body copies the whole thread; `turnId` names the turn the copy ends with.
        const body = await readJson(req);
        return sendJson(
          res,
          201,
          await manager.forkThread(threadId, {
            ...(typeof body?.turnId === 'string' ? { turnId: body.turnId } : {}),
            worktree: body?.worktree === true,
          }),
        );
      }

      if (method === 'POST' && sub === 'cancel') {
        return sendJson(res, 200, await manager.cancelTurn(threadId));
      }
    }

    // POST /api/approvals/:id
    if (method === 'POST' && parts[1] === 'approvals' && parts[2]) {
      const body = await readJson(req);
      const decision: ApprovalDecision = body.cancel ? { cancelled: true } : { optionId: String(body.optionId ?? '') };
      if (!('cancelled' in decision) && !decision.optionId) throw new HttpError(400, 'optionId is required');
      if (!manager.resolveApproval(parts[2], decision)) throw new HttpError(404, 'approval not found or already resolved');
      res.writeHead(204).end();
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  };

  return createServer((req, res) => {
    handle(req, res).catch((err) => sendError(res, err));
  });
}

/**
 * List directory contents, with validation against allowed workdirs.
 * Returns { path, files: [{name, type, size?, modified?}], parent? }
 */
function listDirectory(allowedWorkdirs: string[], dirPath: string) {
  const path = resolveAndValidate(allowedWorkdirs, dirPath);
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new HttpError(404, 'directory not found');
  }

  const entries = readdirSync(path, { withFileTypes: true });
  const files = entries.map((e) => {
    const stat = statSync(join(path, e.name));
    return {
      name: e.name,
      type: e.isDirectory() ? ('dir' as const) : ('file' as const),
      size: stat.size,
      modified: stat.mtime.toISOString(),
    };
  });

  const parent = path === normalize(allowedWorkdirs[0]) ? null : normalize(join(path, '..'));
  return { path, files, parent };
}

/**
 * Recursively build directory tree structure.
 * Returns { name, path, type: 'dir', children?: [] }
 */
function buildDirectoryTree(
  allowedWorkdirs: string[],
  rootPath: string,
  maxDepth: number,
  currentDepth = 0,
): any {
  const path = resolveAndValidate(allowedWorkdirs, rootPath);
  const stat = statSync(path);
  const name = path.split(sep).pop() || path;

  if (!stat.isDirectory()) {
    throw new HttpError(400, 'root must be a directory');
  }

  const node: any = { name, path, type: 'dir' };
  if (currentDepth >= maxDepth) return node;

  try {
    const entries = readdirSync(path, { withFileTypes: true });
    node.children = entries
      // Directories only, without hidden ones and dependency folders: nobody starts a thread in those,
      // and they can hold thousands of entries.
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => buildDirectoryTree(allowedWorkdirs, join(path, e.name), maxDepth, currentDepth + 1))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (node.children.length === 0) delete node.children;
  } catch {
    // Permission denied or other errors: skip children
  }

  return node;
}

/**
 * Resolve a path and validate it's within allowed workdirs.
 * Prevents directory traversal attacks.
 */
function resolveAndValidate(allowedWorkdirs: string[], inputPath: string): string {
  const path = resolve(inputPath);
  if (!isWithinWorkdirs(path, allowedWorkdirs)) throw new HttpError(403, 'path is not in allowed workdirs');
  return path;
}

/**
 * Listens on a unix socket that only this user can open, for the server whose requests need no
 * token. A socket another live daemon holds is left to it, and false is returned; one nobody
 * answers on is a leftover and is replaced.
 */
export async function listenPrivate(server: Server, path: string): Promise<boolean> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const held = await new Promise<boolean>((done) => {
      const probe = connect(path);
      probe.on('connect', () => {
        probe.destroy();
        done(true);
      });
      probe.on('error', () => done(false));
    });
    if (held) return false;
    rmSync(path, { force: true });
  }
  // bind() happens inside listen(), so the mask is narrowed for that call alone: the socket is
  // never there with wider permissions, and nothing started meanwhile inherits the mask.
  const umask = process.umask(0o077);
  let listening: Promise<void>;
  try {
    listening = new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(path, () => {
        server.off('error', fail);
        done();
      });
    });
  } finally {
    process.umask(umask);
  }
  await listening;
  server.on('close', () => rmSync(path, { force: true }));
  return true;
}

function finishStream(req: IncomingMessage, res: ServerResponse, off: () => void): void {
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  const close = () => {
    clearInterval(ping);
    off();
    res.end();
  };
  req.on('close', close);
}
