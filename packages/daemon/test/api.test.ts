import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AgentRegistry, defaultInstances } from '../src/agents.js';
import { AgyAdapter } from '../src/adapters/agy.js';
import { ClaudeAcpAdapter } from '../src/adapters/claude.js';
import { PiRpcAdapter } from '../src/adapters/pi.js';
import type { AgentAdapter } from '../src/adapters/types.js';
import { AttachmentStore, sniffImageType } from '../src/attachments.js';
import { createHttpServer, tokenMatches } from '../src/http.js';
import { Store } from '../src/store.js';
import { ThreadManager } from '../src/threads.js';

const here = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-token-0123456789';

let server: Server;
let base: string;
let dataDir: string;
let workdir: string;
let manager: ThreadManager;
let store: Store;

const auth = { Authorization: `Bearer ${TOKEN}` };

async function api(path: string, init: RequestInit = {}, withAuth = true): Promise<Response> {
  const headers = { 'Content-Type': 'application/json', ...(withAuth ? auth : {}), ...(init.headers ?? {}) };
  return fetch(base + path, { ...init, headers });
}

async function waitFor<T>(fn: () => Promise<T | null | undefined>, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'rah-test-data-'));
  // The fake ACP agent appends the ids it is asked to delete to this file.
  process.env.FAKE_ACP_DELETE_LOG = join(dataDir, 'acp-deleted.log');
  // Sessions the fake agents claim to have already. Tests fill these in; they start out empty.
  process.env.FAKE_ACP_SESSIONS_FILE = join(dataDir, 'acp-sessions.json');
  process.env.PI_CODING_AGENT_DIR = join(dataDir, 'pi-agent');
  process.env.RAH_AGY_HOME = join(dataDir, 'agy-home');
  workdir = mkdtempSync(join(tmpdir(), 'rah-test-work-'));
  const adapters = new Map<string, AgentAdapter>();
  adapters.set('claude', new ClaudeAcpAdapter([process.execPath, join(here, 'fixtures', 'fake-acp.mjs')]));
  adapters.set('pi', new PiRpcAdapter([process.execPath, join(here, 'fixtures', 'fake-pi.mjs')]));
  adapters.set('agy', new AgyAdapter([process.execPath, join(here, 'fixtures', 'fake-agy.mjs')]));
  store = new Store(dataDir);
  manager = new ThreadManager(store, adapters, [workdir], new AttachmentStore(dataDir));
  server = createHttpServer({ manager, token: TOKEN, webDir: null, version: 'test' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  server.close();
  await manager.shutdown();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

test('tokenMatches compares in constant time and rejects wrong or missing tokens', () => {
  assert.equal(tokenMatches(TOKEN, TOKEN), true);
  assert.equal(tokenMatches(TOKEN + 'x', TOKEN), false);
  assert.equal(tokenMatches(undefined, TOKEN), false);
  assert.equal(tokenMatches('', TOKEN), false);
});

test('health is open, other API routes need the bearer token', async () => {
  const health = await api('/api/health', {}, false);
  assert.equal(health.status, 200);
  const denied = await api('/api/threads', {}, false);
  assert.equal(denied.status, 401);
  const wrong = await fetch(base + '/api/threads', { headers: { Authorization: 'Bearer nope' } });
  assert.equal(wrong.status, 401);
});

test('agents list reports availability and capabilities', async () => {
  const res = await api('/api/agents');
  const agents = (await res.json()) as Array<{ id: string; available: boolean; capabilities: { resume: boolean } }>;
  assert.deepEqual(agents.map((a) => a.id).sort(), ['agy', 'claude', 'pi']);
  assert.ok(agents.every((a) => a.available && a.capabilities.resume));
});

test('config exposes allowed workdirs', async () => {
  const res = await api('/api/config');
  assert.deepEqual(((await res.json()) as { workdirs: string[] }).workdirs, [workdir]);
});

test('threads can start in an allowed workdir or below it, and nowhere else', async () => {
  const res = await api('/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'claude', cwd: '/' }) });
  assert.equal(res.status, 400);

  // A subdirectory of an allowed workdir is fine: that is what the directory picker offers.
  const sub = join(workdir, 'packages', 'app');
  mkdirSync(sub, { recursive: true });
  const inside = await api('/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'claude', cwd: sub }) });
  assert.equal(inside.status, 201);
  assert.equal(((await inside.json()) as { cwd: string }).cwd, sub);
  assert.equal((await api(`/api/agents/claude/commands?cwd=${encodeURIComponent(sub)}`)).status, 200);

  // A sibling whose name merely starts the same way is not inside it.
  assert.equal((await api('/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'claude', cwd: workdir + '-other' }) })).status, 400);
  // ".." does not get out.
  assert.equal((await api('/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'claude', cwd: join(workdir, '..') }) })).status, 400);
  // Neither does a symlink that lives inside the workdir but points outside it.
  const escape = join(workdir, 'escape');
  symlinkSync(dataDir, escape);
  assert.equal((await api('/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'claude', cwd: escape }) })).status, 400);
  assert.equal((await api(`/api/directory-tree?root=${encodeURIComponent(escape)}`)).status, 403);
  assert.equal((await api(`/api/directories?path=${encodeURIComponent(escape)}`)).status, 403);

  // The tree leaves out hidden folders and node_modules.
  mkdirSync(join(workdir, '.git'));
  mkdirSync(join(workdir, 'node_modules'));
  const tree = (await (await api(`/api/directory-tree?root=${encodeURIComponent(workdir)}`)).json()) as { children: Array<{ name: string }> };
  assert.deepEqual(tree.children.map((c) => c.name), ['packages']);
  const bad = await api('/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'nope', cwd: workdir }) });
  assert.equal(bad.status, 400);
});

test('claude thread: send a turn, get streamed events, title set from first message', async () => {
  const created = await api('/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'claude', cwd: workdir }) });
  assert.equal(created.status, 201);
  const thread = (await created.json()) as { id: string; title: string };
  assert.equal(thread.title, 'New thread');

  const turn = await api(`/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'list files' }) });
  assert.equal(turn.status, 202);

  const events = await waitFor(async () => {
    const list = (await (await api(`/api/threads/${thread.id}/events`)).json()) as Array<{ type: string }>;
    return list.some((e) => e.type === 'turn.done') ? list : null;
  });
  const types = events.map((e) => e.type);
  assert.equal(types[0], 'thread.created');
  assert.ok(types.includes('turn.started'));
  assert.ok(types.includes('message.delta'));
  assert.ok(types.includes('tool.end'));
  assert.equal(events.at(-1)?.type, 'thread.updated');

  const after = (await (await api(`/api/threads/${thread.id}`)).json()) as { title: string; status: string; agentSessionId: string };
  assert.equal(after.title, 'list files');
  assert.equal(after.status, 'idle');
  assert.equal(after.agentSessionId, 'acp-session-1');
});

test('a second turn while one is running is refused with 409', async () => {
  const created = await api('/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: workdir }) });
  const thread = (await created.json()) as { id: string };
  const first = await api(`/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'slow job' }) });
  assert.equal(first.status, 202);
  const second = await api(`/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'again' }) });
  assert.equal(second.status, 409);
  const cancel = await api(`/api/threads/${thread.id}/cancel`, { method: 'POST' });
  assert.equal(cancel.status, 200);
  assert.deepEqual(await cancel.json(), { dropped: [] });
  await waitFor(async () => {
    const list = (await (await api(`/api/threads/${thread.id}/events`)).json()) as Array<{ type: string }>;
    return list.some((e) => e.type === 'turn.done') ? list : null;
  });
});

test('approval: request appears as an event and the decision reaches the agent', async () => {
  const created = await api('/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'claude', cwd: workdir }) });
  const thread = (await created.json()) as { id: string };
  await api(`/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'please approve' }) });

  const request = await waitFor(async () => {
    const list = (await (await api(`/api/threads/${thread.id}/events`)).json()) as Array<{ type: string; data: any }>;
    return list.find((e) => e.type === 'approval.request') ?? null;
  });
  assert.equal(request.data.options.length, 2);

  // An option the agent never offered is refused, and the approval stays open.
  const bogus = await api(`/api/approvals/${request.data.approvalId}`, {
    method: 'POST',
    body: JSON.stringify({ optionId: 'allow-once' }),
  });
  assert.equal(bogus.status, 400);

  const decide = await api(`/api/approvals/${request.data.approvalId}`, {
    method: 'POST',
    body: JSON.stringify({ optionId: 'allow' }),
  });
  assert.equal(decide.status, 204);

  const finished = await waitFor(async () => {
    const list = (await (await api(`/api/threads/${thread.id}/events`)).json()) as Array<{ type: string; data: any }>;
    return list.some((e) => e.type === 'turn.done') ? list : null;
  });
  assert.ok(finished.some((e) => e.type === 'approval.resolved'));
  const reply = finished.filter((e) => e.type === 'message.delta').map((e) => e.data.text).join('');
  assert.ok(reply.includes('approved:allow'));

  const again = await api(`/api/approvals/${request.data.approvalId}`, { method: 'POST', body: JSON.stringify({ optionId: 'allow' }) });
  assert.equal(again.status, 404);
});

test('SSE stream replays the backlog after a given seq and then pushes live events', async () => {
  const created = await api('/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: workdir }) });
  const thread = (await created.json()) as { id: string };
  await api(`/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'hello sse' }) });
  await waitFor(async () => {
    const list = (await (await api(`/api/threads/${thread.id}/events`)).json()) as Array<{ type: string }>;
    return list.some((e) => e.type === 'turn.done') ? list : null;
  });

  const res = await api(`/api/threads/${thread.id}/stream?after=1`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + 5000;
  while (!text.includes('event: turn.done') && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  assert.ok(text.includes('event: turn.started'), 'backlog should include turn.started');
  assert.ok(text.includes('event: turn.done'));
  assert.ok(!text.includes('event: thread.created'), 'events at or before the cursor must be skipped');
  await reader.cancel();
});

test('unknown thread returns 404 and malformed JSON returns 400', async () => {
  const missing = await api('/api/threads/does-not-exist');
  assert.equal(missing.status, 404);
  const bad = await fetch(base + '/api/threads', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(bad.status, 400);
});

test('agents report permission modes and effort levels; pi has no permission modes', async () => {
  const agents = (await (await api('/api/agents')).json()) as Array<{ id: string; capabilities: any }>;
  const claude = agents.find((a) => a.id === 'claude')!;
  const pi = agents.find((a) => a.id === 'pi')!;
  assert.deepEqual(claude.capabilities.permissionModes, ['ask', 'auto_edit', 'full_access']);
  assert.ok(claude.capabilities.effortLevels.includes('max'));
  assert.deepEqual(pi.capabilities.permissionModes, []);
});

test('model and command lists are served per agent; unknown agents are 404', async () => {
  const models = (await (await api('/api/agents/claude/models')).json()) as Array<{ id: string }>;
  assert.deepEqual(models.map((m) => m.id), ['default', 'big', 'small']);
  const commands = (await (await api('/api/agents/claude/commands')).json()) as Array<{ name: string }>;
  assert.deepEqual(commands.map((c) => c.name), ['compact', 'review', 'cost', 'stats']);
  assert.equal((await api('/api/agents/nope/models')).status, 404);
});

test('new threads default to auto_edit; settings are validated and stored', async () => {
  const created = await api('/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'claude', cwd: workdir }) });
  const thread = (await created.json()) as { id: string; permissionMode: string; model: string | null; effort: string | null };
  assert.equal(thread.permissionMode, 'auto_edit');
  assert.equal(thread.model, null);
  assert.equal(thread.effort, null);

  const patch = (body: unknown) => api(`/api/threads/${thread.id}`, { method: 'PATCH', body: JSON.stringify(body) });
  const ok = await patch({ permissionMode: 'full_access', model: 'big', effort: 'high' });
  assert.equal(ok.status, 200);
  assert.deepEqual(
    (({ permissionMode, model, effort }) => ({ permissionMode, model, effort }))((await ok.json()) as any),
    { permissionMode: 'full_access', model: 'big', effort: 'high' },
  );

  assert.equal((await patch({ permissionMode: 'root' })).status, 400);
  assert.equal((await patch({ model: 'does-not-exist' })).status, 400);
  assert.equal((await patch({ effort: 'ludicrous' })).status, 400);

  const cleared = (await (await patch({ model: null, effort: null })).json()) as { model: null; effort: null };
  assert.equal(cleared.model, null);
  assert.equal(cleared.effort, null);
});

test('settings chosen at creation reach the agent on the first turn', async () => {
  const created = await api('/api/threads', {
    method: 'POST',
    body: JSON.stringify({ agent: 'claude', cwd: workdir, permissionMode: 'full_access', model: 'big', effort: 'high' }),
  });
  const thread = (await created.json()) as { id: string };
  await api(`/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'model?' }) });
  const events = await waitFor(async () => {
    const list = (await (await api(`/api/threads/${thread.id}/events`)).json()) as Array<{ type: string; data: any }>;
    return list.some((e) => e.type === 'turn.done') ? list : null;
  });
  const reply = events.filter((e) => e.type === 'message.delta').map((e) => e.data.text).join('');
  // The fake echoes the prompt first; the settings line is what matters here.
  assert.ok(reply.endsWith('model:big;mode:bypassPermissions;effort:high'), reply);
});

test('pi rejects a permission mode, since it has none', async () => {
  const res = await api('/api/threads', {
    method: 'POST',
    body: JSON.stringify({ agent: 'pi', cwd: workdir, permissionMode: 'ask' }),
  });
  assert.equal(res.status, 201, 'pi ignores the permission mode at creation');
  const thread = (await res.json()) as { id: string };
  const patched = await api(`/api/threads/${thread.id}`, { method: 'PATCH', body: JSON.stringify({ permissionMode: 'ask' }) });
  assert.equal(patched.status, 400);
});

test('deleting a thread removes it and its events; a running thread cannot be deleted', async () => {
  const created = await api('/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: workdir }) });
  const thread = (await created.json()) as { id: string };
  await api(`/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'slow job' }) });
  assert.equal((await api(`/api/threads/${thread.id}`, { method: 'DELETE' })).status, 409);
  await api(`/api/threads/${thread.id}/cancel`, { method: 'POST' });
  await waitFor(async () => {
    const t = (await (await api(`/api/threads/${thread.id}`)).json()) as { status: string };
    return t.status !== 'running' ? t : null;
  });
  assert.equal((await api(`/api/threads/${thread.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await api(`/api/threads/${thread.id}`)).status, 404);
  assert.equal((await api(`/api/threads/${thread.id}/events`)).status, 404);
  assert.equal((await api(`/api/threads/${thread.id}`, { method: 'DELETE' })).status, 404);
});

test('effort is checked against the model: a model without effort rejects it, and switching clears it', async () => {
  const created = await api('/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'claude', cwd: workdir }) });
  const thread = (await created.json()) as { id: string };
  const patch = async (body: unknown) => {
    const res = await api(`/api/threads/${thread.id}`, { method: 'PATCH', body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as { model: string | null; effort: string | null } };
  };

  // "max" exists on the default model but not on "big".
  assert.equal((await patch({ effort: 'max' })).body.effort, 'max');
  const toBig = await patch({ model: 'big' });
  assert.deepEqual([toBig.body.model, toBig.body.effort], ['big', null], 'unsupported effort is dropped with the model change');

  assert.equal((await patch({ effort: 'max' })).status, 400);
  assert.equal((await patch({ effort: 'high' })).body.effort, 'high');

  // "small" has no effort setting at all.
  const toSmall = await patch({ model: 'small' });
  assert.deepEqual([toSmall.body.model, toSmall.body.effort], ['small', null]);
  assert.equal((await patch({ effort: 'low' })).status, 400);

  // Model and effort in one request are checked together.
  assert.equal((await patch({ model: 'big', effort: 'max' })).status, 400);
  assert.equal((await patch({ model: null, effort: 'max' })).body.effort, 'max');
});

test('creating a thread with an effort the chosen model lacks is rejected; unusable models are not offered', async () => {
  const bad = await api('/api/threads', {
    method: 'POST',
    body: JSON.stringify({ agent: 'claude', cwd: workdir, model: 'small', effort: 'high' }),
  });
  assert.equal(bad.status, 400);
  const broken = await api('/api/threads', {
    method: 'POST',
    body: JSON.stringify({ agent: 'claude', cwd: workdir, model: 'broken' }),
  });
  assert.equal(broken.status, 400);
  const piPlain = await api('/api/threads', {
    method: 'POST',
    body: JSON.stringify({ agent: 'pi', cwd: workdir, model: 'fake/plain', effort: 'high' }),
  });
  assert.equal(piPlain.status, 400);
  const piThink = await api('/api/threads', {
    method: 'POST',
    body: JSON.stringify({ agent: 'pi', cwd: workdir, model: 'fake/think', effort: 'high' }),
  });
  assert.equal(piThink.status, 201);
});

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
// Only the header matters to the daemon, which reads the type from the first bytes.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]).toString('base64');

test('sniffImageType recognises the four image formats and nothing else', () => {
  assert.equal(sniffImageType(Buffer.from(PNG, 'base64')), 'image/png');
  assert.equal(sniffImageType(Buffer.from(JPEG, 'base64')), 'image/jpeg');
  assert.equal(sniffImageType(Buffer.from('GIF89a......', 'latin1')), 'image/gif');
  assert.equal(sniffImageType(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1')), 'image/webp');
  assert.equal(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(sniffImageType(Buffer.from('<script>alert(1)</script>')), null);
  assert.equal(sniffImageType(Buffer.alloc(0)), null);
});

async function newThread(body: Record<string, unknown>): Promise<{ id: string; title: string }> {
  const res = await api('/api/threads', { method: 'POST', body: JSON.stringify({ cwd: workdir, ...body }) });
  assert.equal(res.status, 201);
  return (await res.json()) as { id: string; title: string };
}

async function finishedEvents(threadId: string): Promise<Array<{ type: string; data: any }>> {
  return waitFor(async () => {
    const list = (await (await api(`/api/threads/${threadId}/events`)).json()) as Array<{ type: string; data: any }>;
    return list.some((e) => e.type === 'turn.done' || e.type === 'turn.error') ? list : null;
  });
}

test('a turn can carry images: stored on disk, listed in the event, served back, sent to the agent', async () => {
  const thread = await newThread({ agent: 'claude' });
  const sent = await api(`/api/threads/${thread.id}/turns`, {
    method: 'POST',
    // The second image claims to be a PNG but is a JPEG: the bytes decide.
    body: JSON.stringify({ text: 'what is this', images: [{ data: PNG, mimeType: 'image/png' }, { data: `data:image/png;base64,${JPEG}`, mimeType: 'image/png' }] }),
  });
  assert.equal(sent.status, 202);
  const events = await finishedEvents(thread.id);
  const started = events.find((e) => e.type === 'turn.started')!;
  assert.equal(started.data.text, 'what is this');
  assert.deepEqual(started.data.images.map((i: any) => i.mimeType), ['image/png', 'image/jpeg']);
  assert.equal(JSON.stringify(started.data).includes(PNG), false, 'image bytes stay out of the event log');

  const reply = events.filter((e) => e.type === 'message.delta').map((e) => e.data.text).join('');
  assert.ok(reply.startsWith('images:2:image/png,image/jpeg;'), reply);

  const first = started.data.images[0];
  const file = await api(`/api/threads/${thread.id}/attachments/${first.id}`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(Buffer.from(await file.arrayBuffer()).toString('base64'), PNG);

  assert.equal((await api(`/api/threads/${thread.id}/attachments/${first.id}`, {}, false)).status, 401);
  assert.equal((await api(`/api/threads/${thread.id}/attachments/not-an-id`)).status, 404);
  assert.equal((await api(`/api/threads/${thread.id}/attachments/..%2F..%2Fhub.db`)).status, 404);
  const other = await newThread({ agent: 'claude' });
  assert.equal((await api(`/api/threads/${other.id}/attachments/${first.id}`)).status, 404, 'ids do not cross threads');

  // Deleting the thread removes its files too.
  assert.equal(existsSync(join(dataDir, 'attachments', thread.id)), true);
  assert.equal((await api(`/api/threads/${thread.id}`, { method: 'DELETE' })).status, 204);
  assert.equal(existsSync(join(dataDir, 'attachments', thread.id)), false);
});

test('an image with no text is a valid turn; an empty turn is not', async () => {
  const thread = await newThread({ agent: 'claude' });
  assert.equal((await api(`/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: '  ' }) })).status, 400);
  const sent = await api(`/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ images: [{ data: PNG }] }) });
  assert.equal(sent.status, 202);
  await finishedEvents(thread.id);
  const after = (await (await api(`/api/threads/${thread.id}`)).json()) as { title: string };
  assert.equal(after.title, '图片');
});

test('bad images are rejected and leave the thread idle with nothing stored', async () => {
  const thread = await newThread({ agent: 'claude' });
  const post = (images: unknown) =>
    api(`/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'x', images }) });
  const notImage = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
  assert.equal((await post([{ data: notImage, mimeType: 'image/png' }])).status, 400);
  assert.equal((await post([{ mimeType: 'image/png' }])).status, 400);
  assert.equal((await post(Array.from({ length: 7 }, () => ({ data: PNG })))).status, 400);
  // One bad image rejects the whole message, including the good one before it.
  assert.equal((await post([{ data: PNG }, { data: notImage }])).status, 400);
  const tooBig = Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.alloc(5 * 1024 * 1024)]).toString('base64');
  assert.equal((await post([{ data: tooBig }])).status, 413);

  assert.equal(existsSync(join(dataDir, 'attachments', thread.id)), false);
  const state = (await (await api(`/api/threads/${thread.id}`)).json()) as { status: string };
  assert.equal(state.status, 'idle');
  const events = (await (await api(`/api/threads/${thread.id}/events`)).json()) as Array<{ type: string }>;
  assert.equal(events.some((e) => e.type === 'turn.started'), false);
});

test('a model that cannot read images refuses them; the same thread works after switching model', async () => {
  const thread = await newThread({ agent: 'pi', model: 'fake/plain' });
  const post = () => api(`/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'look', images: [{ data: PNG }] }) });
  const refused = await post();
  assert.equal(refused.status, 400);
  assert.match(((await refused.json()) as { error: string }).error, /Plain cannot read images/);

  await api(`/api/threads/${thread.id}`, { method: 'PATCH', body: JSON.stringify({ model: 'fake/think' }) });
  assert.equal((await post()).status, 202);
  const events = await finishedEvents(thread.id);
  assert.ok(events.filter((e) => e.type === 'message.delta').map((e) => e.data.text).join('').startsWith('images:1:image/png;'));

  // No override means pi's own default model, which the fake reports as "think" (reads images).
  const byDefault = await newThread({ agent: 'pi' });
  const viaDefault = await api(`/api/threads/${byDefault.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'look', images: [{ data: PNG }] }) });
  assert.equal(viaDefault.status, 202);
  await finishedEvents(byDefault.id);
});

test('pi effort levels come from the model: the default model takes only what it maps', async () => {
  const thread = await newThread({ agent: 'pi' });
  const patch = async (body: unknown) => (await api(`/api/threads/${thread.id}`, { method: 'PATCH', body: JSON.stringify(body) })).status;
  assert.equal(await patch({ effort: 'medium' }), 400, 'the default model (think) maps medium to null');
  assert.equal(await patch({ effort: 'max' }), 200);
  assert.equal(await patch({ model: 'fake/loose', effort: 'medium' }), 200);
  assert.equal(await patch({ effort: 'max' }), 400, 'loose has no explicit max mapping');
});

test('commands can be asked for a directory, which must be an allowed workdir', async () => {
  const ok = await api(`/api/agents/pi/commands?cwd=${encodeURIComponent(workdir)}`);
  assert.equal(ok.status, 200);
  const list = (await ok.json()) as Array<{ name: string; kind: string }>;
  // pi's built-ins that its RPC answers come first, then what pi lists for the directory.
  assert.deepEqual(list.map((c) => [c.name, c.kind]), [
    ['compact', 'command'],
    ['session', 'command'],
    ['fix-tests', 'prompt'],
    ['skill:pdf', 'skill'],
    ['deploy', 'command'],
  ]);
  assert.equal((await api(`/api/agents/pi/commands?cwd=${encodeURIComponent('/')}`)).status, 400);
  assert.equal((await api('/api/agents/claude/commands')).status, 200);
});

test('file changes from an edit arrive as diff content on the tool events', async () => {
  const thread = await newThread({ agent: 'claude' });
  await api(`/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'please edit file' }) });
  const events = await finishedEvents(thread.id);
  const withDiff = events.find((e) => e.type.startsWith('tool.') && e.data.id === 'e1' && Array.isArray(e.data.content) && e.data.content.length);
  assert.ok(withDiff, 'expected a tool event carrying diff content');
  assert.equal(withDiff!.data.content[0].type, 'diff');
  assert.match(withDiff!.data.content[0].path, /src\/app\.ts$/);
});

const patchThread = async (id: string, body: unknown) => {
  const res = await api(`/api/threads/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};
const listIds = async (query = '') => ((await (await api(`/api/threads${query}`)).json()) as Array<{ id: string }>).map((t) => t.id);

test('archiving hides a thread without losing it, and restoring brings it back as it was', async () => {
  const thread = await newThread({ agent: 'claude' });
  await api(`/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'remember this' }) });
  const before = await finishedEvents(thread.id);

  const archived = await patchThread(thread.id, { archived: true });
  assert.equal(archived.status, 200);
  assert.ok(archived.body.archivedAt);
  assert.equal((await listIds()).includes(thread.id), false, 'gone from the normal list');
  assert.equal((await listIds('?archived=1')).includes(thread.id), true, 'present in the archive');

  // An archived thread keeps its history but takes no new turns.
  const events = (await (await api(`/api/threads/${thread.id}/events`)).json()) as unknown[];
  assert.ok(events.length >= before.length);
  const refused = await api(`/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'hello?' }) });
  assert.equal(refused.status, 409);

  const restored = await patchThread(thread.id, { archived: false });
  assert.equal(restored.body.archivedAt, null);
  assert.equal((await listIds()).includes(thread.id), true);
  // It resumes the same agent session rather than starting a new conversation.
  assert.equal(restored.body.agentSessionId, archived.body.agentSessionId);
  const again = await api(`/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'still there?' }) });
  assert.equal(again.status, 202);
  await waitFor(async () => {
    const list = (await (await api(`/api/threads/${thread.id}/events`)).json()) as Array<{ type: string }>;
    return list.filter((e) => e.type === 'turn.done').length >= 2 ? list : null;
  });
});

test('a running thread cannot be archived until it is stopped', async () => {
  const thread = await newThread({ agent: 'pi' });
  await api(`/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'slow job' }) });
  assert.equal((await patchThread(thread.id, { archived: true })).status, 409);
  await api(`/api/threads/${thread.id}/cancel`, { method: 'POST' });
  await finishedEvents(thread.id);
  assert.equal((await patchThread(thread.id, { archived: true })).status, 200);
});

test('sections: create, file threads under them, rename, and delete without losing threads', async () => {
  const make = await api('/api/sections', { method: 'POST', body: JSON.stringify({ name: '  支付重构 ' }) });
  assert.equal(make.status, 201);
  const section = (await make.json()) as { id: string; name: string; position: number };
  assert.equal(section.name, '支付重构');
  const second = (await (await api('/api/sections', { method: 'POST', body: JSON.stringify({ name: '调研' }) })).json()) as { id: string; position: number };
  assert.ok(second.position > section.position, 'new sections go last');
  assert.equal((await api('/api/sections', { method: 'POST', body: JSON.stringify({ name: '   ' }) })).status, 400);
  assert.equal((await api('/api/sections', { method: 'POST', body: JSON.stringify({ name: 'x'.repeat(41) }) })).status, 400);

  const thread = await newThread({ agent: 'claude' });
  assert.equal((await patchThread(thread.id, { sectionId: section.id })).body.sectionId, section.id);
  assert.equal((await patchThread(thread.id, { sectionId: 'no-such-section' })).status, 400);

  const renamed = await api(`/api/sections/${section.id}`, { method: 'PATCH', body: JSON.stringify({ name: '支付重构二期' }) });
  assert.equal(((await renamed.json()) as { name: string }).name, '支付重构二期');
  const names = ((await (await api('/api/sections')).json()) as Array<{ name: string }>).map((x) => x.name);
  assert.deepEqual(names.slice(-2), ['支付重构二期', '调研']);

  assert.equal((await api(`/api/sections/${section.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await api(`/api/sections/${section.id}`, { method: 'DELETE' })).status, 404);
  const after = (await (await api(`/api/threads/${thread.id}`)).json()) as { sectionId: string | null };
  assert.equal(after.sectionId, null, 'the thread survives and is unfiled');
  assert.equal((await patchThread(thread.id, { sectionId: null })).status, 200);
});

test('filing, pinning or renaming a thread does not move it up the recent list', async () => {
  const older = await newThread({ agent: 'claude' });
  await api(`/api/threads/${older.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'first' }) });
  await finishedEvents(older.id);
  await new Promise((r) => setTimeout(r, 15));
  const newer = await newThread({ agent: 'claude' });
  await api(`/api/threads/${newer.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'second' }) });
  await finishedEvents(newer.id);

  const order = async () => (await listIds()).filter((id) => id === older.id || id === newer.id);
  assert.deepEqual(await order(), [newer.id, older.id]);
  await patchThread(older.id, { title: 'renamed', model: 'big' });
  assert.deepEqual(await order(), [newer.id, older.id], 'settings and renames keep the order');
  // A new message does move it up.
  await api(`/api/threads/${older.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'again' }) });
  assert.deepEqual(await order(), [older.id, newer.id]);
  await waitFor(async () => {
    const t = (await (await api(`/api/threads/${older.id}`)).json()) as { status: string };
    return t.status === 'idle' ? t : null;
  });
});

test('threads carry a terminal resume command once the agent session exists', async () => {
  const thread = await newThread({ agent: 'pi' });
  const fresh = (await (await api(`/api/threads/${thread.id}`)).json()) as { resumeCommand: string | null };
  assert.equal(fresh.resumeCommand, null);
  await api(`/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'hi' }) });
  await finishedEvents(thread.id);
  const after = (await (await api(`/api/threads/${thread.id}`)).json()) as { resumeCommand: string };
  assert.equal(after.resumeCommand, `cd ${workdir} && pi --session pi-session-1`);

  const claude = await newThread({ agent: 'claude' });
  await api(`/api/threads/${claude.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'hi' }) });
  await finishedEvents(claude.id);
  const view = (await (await api(`/api/threads/${claude.id}`)).json()) as { resumeCommand: string };
  assert.equal(view.resumeCommand, `cd ${workdir} && claude --resume acp-session-1`);
});

test('deleting for good can also remove the agent session, where the agent allows it', async () => {
  const log = process.env.FAKE_ACP_DELETE_LOG!;
  const deleted = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);

  const keep = await newThread({ agent: 'claude' });
  await api(`/api/threads/${keep.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'hi' }) });
  await finishedEvents(keep.id);
  const countBefore = deleted().length;
  assert.equal((await api(`/api/threads/${keep.id}`, { method: 'DELETE' })).status, 204);
  assert.equal(deleted().length, countBefore, 'by default the agent session is left alone');

  const both = await newThread({ agent: 'claude' });
  await api(`/api/threads/${both.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'hi' }) });
  await finishedEvents(both.id);
  assert.equal((await api(`/api/threads/${both.id}?agentSession=1`, { method: 'DELETE' })).status, 204);
  assert.equal(deleted().length, countBefore + 1);
  assert.equal(deleted().at(-1), 'acp-session-1');

  // pi cannot delete sessions: the request is refused and the thread is still there.
  const pi = await newThread({ agent: 'pi' });
  await api(`/api/threads/${pi.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'hi' }) });
  await finishedEvents(pi.id);
  assert.equal((await api(`/api/threads/${pi.id}?agentSession=1`, { method: 'DELETE' })).status, 400);
  assert.equal((await api(`/api/threads/${pi.id}`)).status, 200);
  assert.equal((await api(`/api/threads/${pi.id}`, { method: 'DELETE' })).status, 204);

  const agents = (await (await api('/api/agents')).json()) as Array<{ id: string; capabilities: { deleteSession: boolean } }>;
  assert.deepEqual(agents.map((a) => [a.id, a.capabilities.deleteSession]).sort(), [['agy', false], ['claude', true], ['pi', false]]);
});

test('threads report their directory with symlinks resolved, as agents report file paths', async () => {
  const thread = await newThread({ agent: 'claude' });
  const view = (await (await api(`/api/threads/${thread.id}`)).json()) as { cwd: string; cwdReal: string };
  assert.equal(view.cwd, workdir);
  assert.equal(view.cwdReal, realpathSync(workdir));

  // A workdir reached through a symlink keeps its own spelling and also gets the real one.
  const real = join(dataDir, 'real-project');
  const link = join(dataDir, 'linked-project');
  mkdirSync(real);
  symlinkSync(real, link);
  const adapters = new Map<string, AgentAdapter>([['claude', new ClaudeAcpAdapter([process.execPath, join(here, 'fixtures', 'fake-acp.mjs')])]]);
  const linked = new ThreadManager(store, adapters, [link], new AttachmentStore(dataDir));
  const made = await linked.createThread({ agent: 'claude', cwd: link });
  assert.equal(made.cwd, link);
  assert.equal(made.cwdReal, realpathSync(real));
});

const events = async (threadId: string) =>
  (await (await api(`/api/threads/${threadId}/events`)).json()) as Array<{ seq: number; type: string; turnId: string | null; data: any }>;

test('import: sessions the agent already has are listed, and only those in allowed directories', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'rah-test-outside-'));
  try {
    writeFileSync(
      process.env.FAKE_ACP_SESSIONS_FILE!,
      JSON.stringify([
        { sessionId: 'hist-a', cwd: workdir, title: 'Fix the login bug', updatedAt: '2026-03-01T10:00:00.000Z' },
        { sessionId: 'hist-b', cwd: join(workdir, 'packages', 'app'), title: 'Tidy imports', updatedAt: '2026-03-02T10:00:00.000Z' },
        { sessionId: 'hist-elsewhere', cwd: outside, title: 'Not ours', updatedAt: '2026-03-03T10:00:00.000Z' },
        { sessionId: 'hist-gone', cwd: join(workdir, 'deleted-since'), title: 'Directory removed', updatedAt: null },
        { sessionId: 'hist-c', cwd: workdir, title: '', updatedAt: null },
      ]),
    );
    const res = await api('/api/agents/claude/sessions');
    assert.equal(res.status, 200);
    const list = (await res.json()) as Array<{ id: string; cwd: string; title: string; threadId: string | null }>;
    // Five sessions over three pages; the one outside the workdirs and the one whose directory is gone are left out.
    // Newest first, and the one with no date last.
    assert.deepEqual(list.map((s) => s.id), ['hist-b', 'hist-a', 'hist-c']);
    assert.ok(list.every((s) => s.threadId === null));

    assert.equal((await api('/api/agents/nope/sessions')).status, 404);
    assert.equal((await api('/api/agents/claude/sessions', {}, false)).status, 401);

    // A session outside the allowed directories cannot be imported by naming it directly.
    const sneaky = await api('/api/threads/import', { method: 'POST', body: JSON.stringify({ agent: 'claude', sessionId: 'hist-elsewhere' }) });
    assert.equal(sneaky.status, 404);
    assert.equal((await api('/api/threads/import', { method: 'POST', body: JSON.stringify({ agent: 'claude', sessionId: 'no-such' }) })).status, 404);
    assert.equal((await api('/api/threads/import', { method: 'POST', body: JSON.stringify({ agent: 'nope', sessionId: 'hist-a' }) })).status, 400);
    assert.equal((await api('/api/threads/import', { method: 'POST', body: JSON.stringify({}) })).status, 400);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('import: a claude session becomes a thread with its past turns, and carries on in the same session', async () => {
  const res = await api('/api/threads/import', { method: 'POST', body: JSON.stringify({ agent: 'claude', sessionId: 'hist-a' }) });
  assert.equal(res.status, 201);
  const thread = (await res.json()) as { id: string; title: string; cwd: string; agentSessionId: string; status: string; resumeCommand: string };
  assert.equal(thread.title, 'Fix the login bug');
  assert.equal(thread.cwd, workdir);
  assert.equal(thread.agentSessionId, 'hist-a');
  assert.equal(thread.status, 'idle');
  assert.equal(thread.resumeCommand, `cd ${workdir} && claude --resume hist-a`);

  const log = await events(thread.id);
  assert.deepEqual(
    log.map((e) => e.type),
    [
      'thread.created',
      'turn.started', 'reasoning.delta', 'tool.start', 'tool.end', 'message.delta', 'turn.done',
      'turn.started', 'message.delta', 'turn.done',
    ],
  );
  assert.deepEqual(log.map((e) => e.seq), log.map((_, i) => i + 1));
  const started = log.filter((e) => e.type === 'turn.started');
  assert.equal(started[0].data.text, 'first question');
  assert.equal(started[0].data.imported, true);
  assert.notEqual(started[0].turnId, started[1].turnId, 'each past turn has its own id');
  assert.equal(log[3].turnId, started[0].turnId);

  // The picture in the second turn is stored like an uploaded one and served back.
  const [image] = started[1].data.images as Array<{ id: string; mimeType: string }>;
  assert.equal(image.mimeType, 'image/png');
  const served = await api(`/api/threads/${thread.id}/attachments/${image.id}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  await served.arrayBuffer();

  // Listed as a thread now, and a second import is refused.
  const list = (await (await api('/api/agents/claude/sessions')).json()) as Array<{ id: string; threadId: string | null }>;
  assert.equal(list.find((s) => s.id === 'hist-a')?.threadId, thread.id);
  assert.equal(list.find((s) => s.id === 'hist-b')?.threadId, null);
  const again = await api('/api/threads/import', { method: 'POST', body: JSON.stringify({ agent: 'claude', sessionId: 'hist-a' }) });
  assert.equal(again.status, 409);

  // Still refused once archived: the thread exists, it is just hidden.
  await api(`/api/threads/${thread.id}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) });
  assert.equal((await api('/api/threads/import', { method: 'POST', body: JSON.stringify({ agent: 'claude', sessionId: 'hist-a' }) })).status, 409);
  await api(`/api/threads/${thread.id}`, { method: 'PATCH', body: JSON.stringify({ archived: false }) });

  // A new message goes to the same agent session; the replay on load is not shown twice.
  await api(`/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'hello' }) });
  const after = await waitFor(async () => {
    const list = await events(thread.id);
    return list.filter((e) => e.type === 'turn.done').length === 3 ? list : null;
  });
  assert.equal(after.at(-1)!.data.imported, undefined, 'only past turns are marked as imported');
  const answers = after.filter((e) => e.type === 'message.delta').map((e) => e.data.text).join('|');
  assert.match(answers, /^first answer\|second answer\|/);
  assert.equal(answers.split('first answer').length, 2, 'history appears once');
  const view = (await (await api(`/api/threads/${thread.id}`)).json()) as { agentSessionId: string; title: string };
  assert.equal(view.agentSessionId, 'hist-a');
  assert.equal(view.title, 'Fix the login bug', 'the first new message does not rename an imported thread');
});

test('import: two requests for the same session at once make one thread', async () => {
  const body = JSON.stringify({ agent: 'claude', sessionId: 'hist-b' });
  const [a, b] = await Promise.all([
    api('/api/threads/import', { method: 'POST', body }),
    api('/api/threads/import', { method: 'POST', body }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  const made = (await (a.status === 201 ? a : b).json()) as { id: string; cwd: string };
  assert.equal(made.cwd, join(workdir, 'packages', 'app'));
  const all = (await (await api('/api/threads')).json()) as Array<{ agentSessionId: string | null }>;
  assert.equal(all.filter((t) => t.agentSessionId === 'hist-b').length, 1);
});

test('import: a session with no title is named after its first message', async () => {
  const res = await api('/api/threads/import', { method: 'POST', body: JSON.stringify({ agent: 'claude', sessionId: 'hist-c' }) });
  assert.equal(res.status, 201);
  assert.equal(((await res.json()) as { title: string }).title, 'first question');
});

test('import: pi sessions are found from its files and imported with tool calls and pictures', async () => {
  const dir = join(process.env.PI_CODING_AGENT_DIR!, 'sessions', '--work--');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'one.jsonl'),
    [{ type: 'session', id: 'hist-pi', cwd: workdir }, { type: 'message', message: { role: 'user', content: 'run the tests' } }]
      .map((l) => JSON.stringify(l))
      .join('\n'),
  );
  writeFileSync(join(dir, 'two.jsonl'), JSON.stringify({ type: 'session', id: 'hist-pi-outside', cwd: '/' }));

  const list = (await (await api('/api/agents/pi/sessions')).json()) as Array<{ id: string; title: string; threadId: string | null }>;
  assert.deepEqual(list.map((s) => [s.id, s.title, s.threadId]), [['hist-pi', 'run the tests', null]]);

  const res = await api('/api/threads/import', { method: 'POST', body: JSON.stringify({ agent: 'pi', sessionId: 'hist-pi' }) });
  assert.equal(res.status, 201);
  const thread = (await res.json()) as { id: string; agent: string; title: string; resumeCommand: string };
  assert.equal(thread.agent, 'pi');
  assert.equal(thread.title, 'run the tests');
  assert.equal(thread.resumeCommand, `cd ${workdir} && pi --session hist-pi`);

  const log = await events(thread.id);
  assert.deepEqual(
    log.map((e) => e.type),
    [
      'thread.created',
      'turn.started', 'reasoning.delta', 'tool.start', 'tool.end', 'message.delta', 'turn.done',
      'turn.started', 'message.delta', 'turn.done',
    ],
  );
  assert.equal(log[4].data.output, '12 passed');
  assert.equal(log[7].data.images.length, 1);
});

test('fork: the copy has the same history and pictures, its own agent session, and goes its own way', async () => {
  const thread = await newThread({ agent: 'claude', model: 'big', effort: 'high', permissionMode: 'ask' });
  assert.equal((await api(`/api/threads/${thread.id}/fork`, { method: 'POST' })).status, 400, 'nothing to fork before the first message');

  const section = (await (await api('/api/sections', { method: 'POST', body: JSON.stringify({ name: 'Forks' }) })).json()) as { id: string };
  await api(`/api/threads/${thread.id}`, { method: 'PATCH', body: JSON.stringify({ sectionId: section.id }) });
  await api(`/api/threads/${thread.id}/turns`, {
    method: 'POST',
    body: JSON.stringify({ text: 'look at this', images: [{ data: PNG, mimeType: 'image/png' }] }),
  });
  const original = await finishedEvents(thread.id);

  const res = await api(`/api/threads/${thread.id}/fork`, { method: 'POST' });
  assert.equal(res.status, 201);
  const copy = (await res.json()) as Record<string, any>;
  const source = (await (await api(`/api/threads/${thread.id}`)).json()) as Record<string, any>;
  assert.notEqual(copy.id, thread.id);
  assert.equal(copy.title, `${source.title}（分叉）`);
  assert.equal(copy.agentSessionId, `${source.agentSessionId}-fork`);
  for (const key of ['agent', 'cwd', 'model', 'effort', 'permissionMode', 'sectionId']) {
    assert.equal(copy[key], source[key], `${key} carries over`);
  }
  assert.equal(copy.pinned, false);
  assert.equal(copy.forkedFrom, thread.id);
  assert.equal(source.forkedFrom, null);

  const copied = await events(copy.id);
  assert.deepEqual(copied.slice(0, original.length).map((e) => [e.type, e.data]), original.map((e) => [e.type, e.data]));
  const image = copied.find((e) => e.type === 'turn.started')!.data.images[0];
  const served = await api(`/api/threads/${copy.id}/attachments/${image.id}`);
  assert.equal(served.status, 200);
  await served.arrayBuffer();

  // A message to the copy leaves the original as it was.
  await api(`/api/threads/${copy.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'only in the fork' }) });
  await waitFor(async () => {
    const t = (await (await api(`/api/threads/${copy.id}`)).json()) as { status: string };
    return t.status === 'idle' ? t : null;
  });
  assert.equal((await events(thread.id)).length, original.length);
  assert.ok((await events(copy.id)).some((e) => e.type === 'turn.started' && e.data.text === 'only in the fork'));

  // Deleting the copy takes its pictures with it and leaves the original's alone.
  assert.equal((await api(`/api/threads/${copy.id}`, { method: 'DELETE' })).status, 204);
  const mine = original.find((e) => e.type === 'turn.started')!.data.images[0];
  const still = await api(`/api/threads/${thread.id}/attachments/${mine.id}`);
  assert.equal(still.status, 200);
  await still.arrayBuffer();
  await api(`/api/sections/${section.id}`, { method: 'DELETE' });
});

test('fork: refused while a turn is running, and a failure on the agent side leaves no thread behind', async () => {
  const busy = await newThread({ agent: 'claude' });
  await api(`/api/threads/${busy.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'hi' }) });
  await finishedEvents(busy.id);
  await api(`/api/threads/${busy.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'slow' }) });
  assert.equal((await api(`/api/threads/${busy.id}/fork`, { method: 'POST' })).status, 409);
  await api(`/api/threads/${busy.id}/cancel`, { method: 'POST' });
  await waitFor(async () => {
    const t = (await (await api(`/api/threads/${busy.id}`)).json()) as { status: string };
    return t.status === 'idle' ? t : null;
  });

  const before = ((await (await api('/api/threads')).json()) as unknown[]).length;
  const stuck = await manager.createThread({ agent: 'claude', cwd: workdir });
  store.updateThread(stuck.id, { agentSessionId: 'unforkable' });
  const res = await api(`/api/threads/${stuck.id}/fork`, { method: 'POST' });
  assert.equal(res.status, 502);
  assert.match(((await res.json()) as { error: string }).error, /cannot fork/);
  assert.equal(((await (await api('/api/threads')).json()) as unknown[]).length, before + 1, 'only the thread made for this test was added');

  assert.equal((await api('/api/threads/no-such-thread/fork', { method: 'POST' })).status, 404);
});

test('fork works for pi too, and agents say whether they can import and fork', async () => {
  const thread = await newThread({ agent: 'pi' });
  await api(`/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'hi' }) });
  await finishedEvents(thread.id);
  const res = await api(`/api/threads/${thread.id}/fork`, { method: 'POST' });
  assert.equal(res.status, 201);
  assert.equal(((await res.json()) as { agentSessionId: string }).agentSessionId, 'pi-session-1-clone');

  const agents = (await (await api('/api/agents')).json()) as Array<{ id: string; capabilities: { history: boolean; fork: boolean } }>;
  assert.deepEqual(agents.map((a) => [a.id, a.capabilities.history, a.capabilities.fork]).sort(), [['agy', false, false], ['claude', true, true], ['pi', true, true]]);
});

test('agy: two permission levels, no approvals, no images; settings are flags of its process', async () => {
  const agents = (await (await api('/api/agents')).json()) as Array<{ id: string; label: string; available: boolean; capabilities: any }>;
  const agy = agents.find((a) => a.id === 'agy')!;
  assert.equal(agy.label, 'Antigravity');
  assert.equal(agy.available, true);
  assert.deepEqual(agy.capabilities.permissionModes, ['auto_edit', 'full_access']);
  assert.deepEqual([agy.capabilities.approvals, agy.capabilities.images, agy.capabilities.effortLevels.length], [false, true, 0]);
  const models = (await (await api('/api/agents/agy/models')).json()) as Array<{ id: string; efforts: string[] }>;
  assert.deepEqual(models.map((m) => m.id), ['fast-low', 'fast-high', 'big-thinking']);

  // It cannot ask, so "ask" is not offered; the default is the level a new thread gets anyway.
  const ask = await api('/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'agy', cwd: workdir, permissionMode: 'ask' }) });
  assert.equal(ask.status, 400);
  assert.equal((await api('/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'agy', cwd: workdir, effort: 'high' }) })).status, 400);
  const thread = (await newThread({ agent: 'agy', model: 'fast-low' })) as { id: string; permissionMode?: string };
  assert.equal(thread.permissionMode, 'auto_edit');

  const replyOf = (list: Array<{ type: string; turnId: string | null; data: any }>, turnId: string | null) =>
    list.filter((e) => e.type === 'message.delta' && e.turnId === turnId).map((e) => e.data.text).join('').trim();
  const sendAndWait = async (text: string) => {
    const res = await api(`/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text }) });
    assert.equal(res.status, 202);
    const { turnId } = (await res.json()) as { turnId: string };
    const list = await waitFor(async () => {
      const all = await events(thread.id);
      return all.some((e) => e.turnId === turnId && (e.type === 'turn.done' || e.type === 'turn.error')) ? all : null;
    });
    return { turnId, list, end: list.find((e) => e.turnId === turnId && (e.type === 'turn.done' || e.type === 'turn.error'))! };
  };

  const first = await sendAndWait('use a tool');
  assert.equal(first.end.type, 'turn.done');
  assert.equal(replyOf(first.list, first.turnId), 'echo:use a tool;model:fast-low;mode:accept-edits;conv:agy-conv-1');
  assert.ok(first.list.some((e) => e.type === 'tool.end' && e.data.output === 'hi\r\n'));
  const view = (await (await api(`/api/threads/${thread.id}`)).json()) as { agentSessionId: string; resumeCommand: string };
  assert.equal(view.agentSessionId, 'agy-conv-1');
  assert.equal(view.resumeCommand, `cd ${workdir} && agy --conversation agy-conv-1`);

  // A command needs a permission it cannot ask for: the turn ends with an explanation.
  const refused = await sendAndWait('run a command');
  assert.equal(refused.end.type, 'turn.error');
  assert.match(refused.end.data.message, /full access/);
  assert.deepEqual([refused.end.data.code, refused.end.data.refused], ['permission_refused', ['RunCommand']]);

  // Raising the level and changing the model both carry on in the same conversation.
  assert.equal((await api(`/api/threads/${thread.id}`, { method: 'PATCH', body: JSON.stringify({ permissionMode: 'full_access', model: 'big-thinking' }) })).status, 200);
  const allowed = await sendAndWait('run a command');
  assert.equal(allowed.end.type, 'turn.done');
  assert.equal(replyOf(allowed.list, allowed.turnId), 'echo:run a command;model:big-thinking;mode:always-proceed;conv:agy-conv-1');

  // Pictures go in as paths to the stored files; agy opens them itself.
  const image = await sendAndWait('look at this');
  assert.equal(image.end.type, 'turn.done');
  const pictured = await api(`/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'look', images: [{ data: PNG, mimeType: 'image/png' }] }) });
  assert.equal(pictured.status, 202);
  const { turnId: picturedTurn } = (await pictured.json()) as { turnId: string };
  const withPicture = await waitFor(async () => {
    const all = await events(thread.id);
    return all.some((e) => e.turnId === picturedTurn && e.type === 'turn.done') ? all : null;
  });
  const stored = withPicture.find((e) => e.turnId === picturedTurn && e.type === 'turn.started')!.data.images[0];
  const said = withPicture.filter((e) => e.turnId === picturedTurn && e.type === 'message.delta').map((e) => e.data.text).join('');
  assert.ok(said.includes(join(dataDir, 'attachments', thread.id, `${stored.id}.png`)), said);

  // What it cannot do is refused up front.
  assert.equal((await api(`/api/threads/${thread.id}/fork`, { method: 'POST' })).status, 400);
  assert.equal((await api('/api/agents/agy/sessions')).status, 400);
});

test('agy: stopping a turn leaves the thread idle and usable', async () => {
  const thread = await newThread({ agent: 'agy' });
  await api(`/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'slow' }) });
  await waitFor(async () => (await events(thread.id)).find((e) => e.type === 'message.delta'));
  assert.equal((await api(`/api/threads/${thread.id}/cancel`, { method: 'POST' })).status, 200);
  const done = await waitFor(async () => (await events(thread.id)).find((e) => e.type === 'turn.done'));
  assert.equal(done.data.stopReason, 'cancelled');
  await api(`/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'hello' }) });
  const list = await waitFor(async () => {
    const all = await events(thread.id);
    return all.filter((e) => e.type === 'turn.done').length === 2 ? all : null;
  });
  assert.ok(list.some((e) => e.type === 'message.delta' && String(e.data.text).startsWith('echo:hello;')));
  const view = (await (await api(`/api/threads/${thread.id}`)).json()) as { status: string };
  assert.equal(view.status, 'idle');
});

const patchRaw = (id: string, body: Record<string, unknown>) => api(`/api/threads/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
type View = { id: string; status: string; unread: boolean; waiting: boolean; updatedAt: string; queued: Array<{ id: string; text: string; images: number }> };
const viewOf = async (id: string) => (await (await api(`/api/threads/${id}`)).json()) as View;
const post = (path: string, body?: unknown) => api(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const untilIdle = (id: string) =>
  waitFor(async () => {
    const t = await viewOf(id);
    return t.status !== 'running' && t.queued.length === 0 ? t : null;
  });
const turnTexts = async (id: string) => (await events(id)).filter((e) => e.type === 'turn.started').map((e) => e.data.text);

test('unread: a finished turn marks the thread, reading clears it, and a stopped turn does not mark it', async () => {
  const thread = await newThread({ agent: 'claude' });
  assert.equal((await viewOf(thread.id)).unread, false);
  await post(`/api/threads/${thread.id}/turns`, { text: 'hi' });
  await finishedEvents(thread.id);
  const done = await waitFor(async () => {
    const t = await viewOf(thread.id);
    return t.status === 'idle' ? t : null;
  });
  assert.equal(done.unread, true);

  // Marking it read is not activity: the thread keeps its place in the list.
  const read = (await (await patchRaw(thread.id, { unread: false })).json()) as View;
  assert.deepEqual([read.unread, read.updatedAt], [false, done.updatedAt]);
  assert.equal(((await (await patchRaw(thread.id, { unread: true })).json()) as View).unread, true, 'it can be marked unread by hand');
  assert.equal((await patchRaw(thread.id, { unread: 'yes' })).status, 400);
  await patchRaw(thread.id, { unread: false });

  await post(`/api/threads/${thread.id}/turns`, { text: 'slow' });
  await post(`/api/threads/${thread.id}/cancel`);
  const stopped = await untilIdle(thread.id);
  assert.equal(stopped.unread, false, 'the user stopped it, so there is nothing new to look at');

  // An error is news too.
  const pi = await newThread({ agent: 'pi' });
  await post(`/api/threads/${pi.id}/turns`, { text: 'please fail' });
  const failed = await waitFor(async () => {
    const t = await viewOf(pi.id);
    return t.status === 'error' ? t : null;
  });
  assert.equal(failed.unread, true);
});

test('waiting: a thread says when its agent is waiting for approval, in the list too', async () => {
  const thread = await newThread({ agent: 'claude', permissionMode: 'ask' });
  assert.equal((await viewOf(thread.id)).waiting, false);
  await post(`/api/threads/${thread.id}/turns`, { text: 'please approve' });
  const request = await waitFor(async () => (await events(thread.id)).find((e) => e.type === 'approval.request'));
  assert.equal((await viewOf(thread.id)).waiting, true);
  const list = (await (await api('/api/threads')).json()) as View[];
  assert.equal(list.find((t) => t.id === thread.id)?.waiting, true);
  assert.equal(list.filter((t) => t.waiting).length, 1);

  await post(`/api/approvals/${request.data.approvalId}`, { optionId: 'allow' });
  const after = await untilIdle(thread.id);
  assert.equal(after.waiting, false);
});

test('the thread-list stream reports approvals, so a waiting thread shows up without polling', async () => {
  const thread = await newThread({ agent: 'claude', permissionMode: 'ask' });
  const ctrl = new AbortController();
  const res = await fetch(base + '/api/stream', { headers: auth, signal: ctrl.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  const until = async (needle: string) => {
    const deadline = Date.now() + 10_000;
    while (!seen.includes(needle)) {
      if (Date.now() > deadline) throw new Error(`stream never sent ${needle}`);
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
  };
  await post(`/api/threads/${thread.id}/turns`, { text: 'please approve' });
  await until('event: turn.started'); // a turn started from anywhere shows the thread as running
  await until('event: approval.request');
  assert.equal(seen.includes('event: message.delta'), false, 'only what the list needs is sent');
  const request = (await events(thread.id)).find((e) => e.type === 'approval.request')!;
  await post(`/api/approvals/${request.data.approvalId}`, { optionId: 'allow' });
  await until('event: approval.resolved');
  ctrl.abort();
  await untilIdle(thread.id);
});

test('queue: a message sent while a turn runs waits, and goes out by itself when the turn ends', async () => {
  const thread = await newThread({ agent: 'claude', permissionMode: 'ask' });
  await post(`/api/threads/${thread.id}/turns`, { text: 'please approve first' });
  const request = await waitFor(async () => (await events(thread.id)).find((e) => e.type === 'approval.request'));

  // Without asking for it, a second message is still refused.
  assert.equal((await post(`/api/threads/${thread.id}/turns`, { text: 'no queue' })).status, 409);
  const queued = await post(`/api/threads/${thread.id}/turns`, { text: 'second', queue: true });
  assert.equal(queued.status, 202);
  const { id: queuedId, queued: isQueued } = (await queued.json()) as { id: string; queued: boolean };
  assert.equal(isQueued, true);
  await post(`/api/threads/${thread.id}/turns`, { text: 'third', queue: true, images: [{ data: PNG, mimeType: 'image/png' }] });
  assert.deepEqual((await viewOf(thread.id)).queued.map((q) => [q.text, q.images]), [['second', 0], ['third', 1]]);
  assert.equal((await viewOf(thread.id)).queued[0].id, queuedId);
  assert.deepEqual(await turnTexts(thread.id), ['please approve first'], 'nothing is sent yet');

  // What would be refused later is refused now, and does not take a place in the queue.
  const bad = await post(`/api/threads/${thread.id}/turns`, { text: 'x', queue: true, images: [{ data: Buffer.from('not an image').toString('base64') }] });
  assert.equal(bad.status, 400);
  assert.equal((await post(`/api/threads/${thread.id}/turns`, { text: '', queue: true })).status, 400);
  assert.equal((await viewOf(thread.id)).queued.length, 2);

  await post(`/api/approvals/${request.data.approvalId}`, { optionId: 'allow' });
  await untilIdle(thread.id);
  assert.deepEqual(await turnTexts(thread.id), ['please approve first', 'second', 'third']);
  const log = await events(thread.id);
  assert.equal(log.filter((e) => e.type === 'turn.done').length, 3);
  assert.equal(log.filter((e) => e.type === 'turn.started').at(-1)!.data.images.length, 1, 'the picture went with its message');

  // With nothing running, "queue" simply sends.
  const direct = await post(`/api/threads/${thread.id}/turns`, { text: 'fourth', queue: true });
  assert.ok(((await direct.json()) as { turnId?: string }).turnId);
  await untilIdle(thread.id);
});

test('queue: a waiting message can be taken back, the queue has a limit, and stopping hands the rest back unsent', async () => {
  const thread = await newThread({ agent: 'claude' });
  await post(`/api/threads/${thread.id}/turns`, { text: 'slow' });
  const ids: string[] = [];
  for (const text of ['a', 'b', 'c', 'd', 'e']) {
    ids.push(((await (await post(`/api/threads/${thread.id}/turns`, { text, queue: true })).json()) as { id: string }).id);
  }
  assert.equal((await post(`/api/threads/${thread.id}/turns`, { text: 'f', queue: true })).status, 409, 'five is the limit');

  assert.equal((await api(`/api/threads/${thread.id}/queue/${ids[1]}`, { method: 'DELETE' })).status, 204);
  assert.equal((await api(`/api/threads/${thread.id}/queue/${ids[1]}`, { method: 'DELETE' })).status, 404);
  assert.equal((await api(`/api/threads/no-such/queue/${ids[0]}`, { method: 'DELETE' })).status, 404);
  assert.deepEqual((await viewOf(thread.id)).queued.map((q) => q.text), ['a', 'c', 'd', 'e']);

  const stop = await post(`/api/threads/${thread.id}/cancel`);
  assert.deepEqual(await stop.json(), { dropped: ['a', 'c', 'd', 'e'] });
  const after = await untilIdle(thread.id);
  assert.deepEqual(after.queued, []);
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(await turnTexts(thread.id), ['slow'], 'stopping sends nothing');
});

test('queue: "send now" interrupts the running turn and puts that message first', async () => {
  const thread = await newThread({ agent: 'pi' });
  await post(`/api/threads/${thread.id}/turns`, { text: 'slow start' });
  await waitFor(async () => (await events(thread.id)).find((e) => e.type === 'message.delta'));
  await post(`/api/threads/${thread.id}/turns`, { text: 'later', queue: true });
  const urgent = (await (await post(`/api/threads/${thread.id}/turns`, { text: 'urgent', queue: true })).json()) as { id: string };

  assert.equal((await post(`/api/threads/${thread.id}/queue/nope/now`)).status, 404);
  assert.equal((await post(`/api/threads/${thread.id}/queue/${urgent.id}/now`)).status, 204);
  await untilIdle(thread.id);
  assert.deepEqual(await turnTexts(thread.id), ['slow start', 'urgent', 'later']);
  const ends = (await events(thread.id)).filter((e) => e.type === 'turn.done').map((e) => e.data.stopReason);
  assert.deepEqual(ends, ['cancelled', 'end_turn', 'end_turn']);
});

test('queue: deleting a thread drops what was waiting in it', async () => {
  const thread = await newThread({ agent: 'claude' });
  await post(`/api/threads/${thread.id}/turns`, { text: 'slow' });
  await post(`/api/threads/${thread.id}/turns`, { text: 'never sent', queue: true });
  await post(`/api/threads/${thread.id}/cancel`);
  await untilIdle(thread.id);
  assert.equal((await api(`/api/threads/${thread.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await api(`/api/threads/${thread.id}`)).status, 404);
});

test('usage and plan: what the agent reports reaches the event log', async () => {
  const claude = await newThread({ agent: 'claude' });
  await post(`/api/threads/${claude.id}/turns`, { text: 'make a plan and report usage' });
  await untilIdle(claude.id);
  const log = await events(claude.id);
  assert.deepEqual(log.find((e) => e.type === 'usage.updated')?.data, { used: 52000, size: 200000, cost: { amount: 0.42, currency: 'USD' } });
  const plan = log.find((e) => e.type === 'plan.updated')!;
  assert.deepEqual(plan.data.entries.map((e: any) => [e.content, e.status]), [
    ['Read the code', 'completed'],
    ['Write the fix', 'in_progress'],
    ['Run the tests', 'pending'],
  ]);

  const pi = await newThread({ agent: 'pi' });
  await post(`/api/threads/${pi.id}/turns`, { text: 'hi' });
  await untilIdle(pi.id);
  const piLog = await events(pi.id);
  assert.deepEqual(piLog.find((e) => e.type === 'usage.updated')?.data, { used: 1200, size: 200000, cost: { amount: 0.02, currency: 'USD' } });
  assert.ok(piLog.findIndex((e) => e.type === 'usage.updated') < piLog.findIndex((e) => e.type === 'turn.done'), 'usage arrives before the turn is reported done');
});

test('files: an image in the thread directory is served; anything else, or anywhere else, is not', async () => {
  const thread = await newThread({ agent: 'claude' });
  const png = Buffer.from(PNG, 'base64');
  mkdirSync(join(workdir, 'out'), { recursive: true });
  writeFileSync(join(workdir, 'out', 'chart.png'), png);
  writeFileSync(join(workdir, 'out', 'notes.txt'), 'just text');
  writeFileSync(join(workdir, 'out', 'fake.png'), 'named like an image, but text');
  writeFileSync(join(dataDir, 'outside.png'), png);
  symlinkSync(join(dataDir, 'outside.png'), join(workdir, 'out', 'link.png'));
  const get = (path?: string) => api(`/api/threads/${thread.id}/files${path === undefined ? '' : `?path=${encodeURIComponent(path)}`}`);

  const relative = await get('out/chart.png');
  assert.equal(relative.status, 200);
  assert.equal(relative.headers.get('content-type'), 'image/png');
  assert.equal(relative.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await relative.arrayBuffer()), png);
  for (const path of [join(workdir, 'out', 'chart.png'), `file://${join(workdir, 'out', 'chart.png')}`, './out/../out/chart.png']) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    await res.arrayBuffer();
  }

  assert.equal((await get('out/notes.txt')).status, 404, 'not an image');
  assert.equal((await get('out/fake.png')).status, 404, 'the bytes decide, not the name');
  assert.equal((await get('out/missing.png')).status, 404);
  assert.equal((await get('out')).status, 404, 'a directory');
  assert.equal((await get(join(dataDir, 'outside.png'))).status, 404, 'outside the thread directory');
  assert.equal((await get('../' + 'outside.png')).status, 404);
  assert.equal((await get('out/link.png')).status, 404, 'a link that leads outside');
  assert.equal((await get()).status, 400);
  assert.equal((await get('')).status, 400);
  assert.equal((await api(`/api/threads/${thread.id}/files?path=out/chart.png`, {}, false)).status, 401);
  assert.equal((await api('/api/threads/nope/files?path=out/chart.png')).status, 404);
});

test("files: an agent's own folder for the session is served too, and only that session's", async () => {
  const brain = join(process.env.RAH_AGY_HOME!, 'brain');
  mkdirSync(join(brain, 'abcdef12-0001'), { recursive: true });
  mkdirSync(join(brain, 'abcdef12-0002'), { recursive: true });
  writeFileSync(join(brain, 'abcdef12-0001', 'made.png'), Buffer.from(PNG, 'base64'));
  writeFileSync(join(brain, 'abcdef12-0002', 'other.png'), Buffer.from(PNG, 'base64'));

  const thread = await newThread({ agent: 'agy' });
  const mine = join(brain, 'abcdef12-0001', 'made.png');
  assert.equal((await api(`/api/threads/${thread.id}/files?path=${encodeURIComponent(mine)}`)).status, 404, 'no session yet');
  store.updateThread(thread.id, { agentSessionId: 'abcdef12-0001' });
  const res = await api(`/api/threads/${thread.id}/files?path=${encodeURIComponent(mine)}`);
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  const other = join(brain, 'abcdef12-0002', 'other.png');
  assert.equal((await api(`/api/threads/${thread.id}/files?path=${encodeURIComponent(other)}`)).status, 404);

  // A claude thread has no such folder, whatever its session is called.
  const claude = await newThread({ agent: 'claude' });
  store.updateThread(claude.id, { agentSessionId: 'abcdef12-0001' });
  assert.equal((await api(`/api/threads/${claude.id}/files?path=${encodeURIComponent(mine)}`)).status, 404);
});

test('commands: agy lists and answers its own commands; the answer is a normal turn in the thread', async () => {
  const list = (await (await api(`/api/agents/agy/commands?cwd=${encodeURIComponent(workdir)}`)).json()) as Array<{ name: string; kind: string }>;
  assert.ok(list.some((c) => c.name === 'usage' && c.kind === 'command'));
  assert.ok(list.some((c) => c.name === 'make-video' && c.kind === 'skill'));
  assert.ok(!list.some((c) => c.name === 'model'));

  const thread = await newThread({ agent: 'agy' });
  await post(`/api/threads/${thread.id}/turns`, { text: '/usage' });
  await untilIdle(thread.id);
  const log = await events(thread.id);
  assert.deepEqual(log.filter((e) => e.type.startsWith('turn.')).map((e) => e.type), ['turn.started', 'turn.done']);
  assert.match(log.find((e) => e.type === 'message.delta')!.data.text, /\|Fast models\|Weekly Limit Remaining\|97%\|/);
});

test('a model that cannot see accepts pictures when the agent has a way to show them to it', async () => {
  process.env.FAKE_PI_VISION = '1';
  const pi = new PiRpcAdapter([process.execPath, join(here, 'fixtures', 'fake-pi.mjs')]);
  try {
    await pi.models(); // the probe runs now, while the extension is "installed"
  } finally {
    delete process.env.FAKE_PI_VISION;
  }
  const withVision = new ThreadManager(store, new Map<string, AgentAdapter>([['pi', pi]]), [workdir], new AttachmentStore(dataDir));
  const thread = await withVision.createThread({ agent: 'pi', cwd: workdir, model: 'fake/plain' });
  const { turnId } = (await withVision.startTurn(thread.id, { text: 'look', images: [{ data: PNG }] })) as { turnId: string };
  const log = await waitFor(async () => {
    const all = withVision.listEvents(thread.id);
    return all.some((e) => e.turnId === turnId && e.type === 'turn.done') ? all : null;
  });
  const said = log.filter((e) => e.type === 'message.delta').map((e) => String(e.data.text)).join('');
  assert.match(said, /The user attached an image/);
  await withVision.shutdown();
});

test('a new thread can be filed into a section right away', async () => {
  const section = (await (await api('/api/sections', { method: 'POST', body: JSON.stringify({ name: '支付重构' }) })).json()) as { id: string };
  const bad = await api('/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: workdir, sectionId: 'nope' }) });
  assert.equal(bad.status, 400);
  const thread = await newThread({ agent: 'pi', cwd: workdir, sectionId: section.id });
  assert.equal((await viewOf(thread.id)).sectionId, section.id);
});

test('sync: turns the terminal added appear, are marked, and warn until the hub writes again', async () => {
  const messagesFile = join(dataDir, 'pi-terminal-messages.json');
  process.env.FAKE_PI_MESSAGES_FILE = messagesFile;
  try {
    const thread = await newThread({ agent: 'pi', cwd: workdir });
    await post(`/api/threads/${thread.id}/turns`, { text: 'hello' });
    await untilIdle(thread.id);
    const view = await viewOf(thread.id);
    assert.equal(view.agentSessionId, 'pi-session-1');
    assert.equal(view.terminalActivity, false);

    // The terminal carries on where the hub left off: same first turn, one more on top.
    writeFileSync(
      messagesFile,
      JSON.stringify({
        'pi-session-1': [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: [{ type: 'text', text: 'hi there hello' }] },
          { role: 'user', content: 'and from the terminal?' },
          { role: 'assistant', content: [{ type: 'text', text: 'done in the terminal' }] },
        ],
      }),
    );
    const res = await api(`/api/threads/${thread.id}/sync`, { method: 'POST' });
    assert.equal(res.status, 200);
    const { added, terminalActivity } = (await res.json()) as { added: number; terminalActivity: boolean };
    assert.equal(added, 1);
    assert.equal(terminalActivity, true);

    const log = await events(thread.id);
    const imported = log.filter((e) => e.data.fromTerminal === true);
    assert.deepEqual(imported.map((e) => e.type), ['turn.started', 'turn.done']);
    assert.equal(imported[0].data.text, 'and from the terminal?');
    assert.equal((await viewOf(thread.id)).terminalActivity, true);

    // Nothing new since the last sync: a second call adds nothing.
    assert.equal(((await (await api(`/api/threads/${thread.id}/sync`, { method: 'POST' })).json()) as { added: number }).added, 0);

    // Writing from here clears the warning.
    await post(`/api/threads/${thread.id}/turns`, { text: 'back on the web' });
    await untilIdle(thread.id);
    assert.equal((await viewOf(thread.id)).terminalActivity, false);
  } finally {
    delete process.env.FAKE_PI_MESSAGES_FILE;
  }
});

test('sync: a hub turn the agent never recorded is skipped, not treated as divergence', async () => {
  const messagesFile = join(dataDir, 'pi-terminal-messages-2.json');
  process.env.FAKE_PI_MESSAGES_FILE = messagesFile;
  try {
    const thread = await newThread({ agent: 'pi', cwd: workdir });
    await post(`/api/threads/${thread.id}/turns`, { text: 'slow' }); // cancelled before the agent settled
    await waitFor(async () => ((await viewOf(thread.id)).status === 'running' ? true : null));
    await api(`/api/threads/${thread.id}/cancel`, { method: 'POST' });
    await untilIdle(thread.id);
    assert.deepEqual(await turnTexts(thread.id), ['slow']);

    writeFileSync(
      messagesFile,
      JSON.stringify({
        'pi-session-1': [
          { role: 'user', content: 'slow' },
          { role: 'assistant', content: [{ type: 'text', text: 'was interrupted' }] },
          { role: 'user', content: 'terminal follow-up' },
          { role: 'assistant', content: [{ type: 'text', text: 'answered in terminal' }] },
        ],
      }),
    );
    const { added } = (await (await api(`/api/threads/${thread.id}/sync`, { method: 'POST' })).json()) as { added: number };
    // 'slow' matches, so the follow-up is new; the hub's own cancelled turn is not in the agent's list.
    assert.equal(added, 1);
    assert.equal((await turnTexts(thread.id)).at(-1), 'terminal follow-up');
  } finally {
    delete process.env.FAKE_PI_MESSAGES_FILE;
  }
});

test('sync: histories that truly disagree append nothing rather than something wrong', async () => {
  const messagesFile = join(dataDir, 'pi-terminal-messages-3.json');
  process.env.FAKE_PI_MESSAGES_FILE = messagesFile;
  try {
    const thread = await newThread({ agent: 'pi', cwd: workdir });
    for (const text of ['one', 'two', 'three', 'four']) {
      await post(`/api/threads/${thread.id}/turns`, { text });
      await untilIdle(thread.id);
    }

    // The agent's side tells a different story from the second turn on.
    writeFileSync(
      messagesFile,
      JSON.stringify({
        'pi-session-1': [
          { role: 'user', content: 'one' },
          { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
          { role: 'user', content: 'something else entirely' },
          { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
        ],
      }),
    );
    const { added } = (await (await api(`/api/threads/${thread.id}/sync`, { method: 'POST' })).json()) as { added: number };
    assert.equal(added, 0);
    assert.equal((await turnTexts(thread.id)).length, 4);
  } finally {
    delete process.env.FAKE_PI_MESSAGES_FILE;
  }
});

test('sync: threads without a session, or with an agent that cannot read history, are refused', async () => {
  const thread = await newThread({ agent: 'pi', cwd: workdir });
  assert.equal((await api(`/api/threads/${thread.id}/sync`, { method: 'POST' })).status, 400);
  const agy = await newThread({ agent: 'agy', cwd: workdir });
  await post(`/api/threads/${agy.id}/turns`, { text: 'hi' });
  await untilIdle(agy.id);
  assert.equal((await api(`/api/threads/${agy.id}/sync`, { method: 'POST' })).status, 400);
});

test('agents: instances beyond the built-ins are listed, and PATH discovery offers extras', async () => {
  const registry = new AgentRegistry(
    [
      ...defaultInstances({
        claudeCommand: [process.execPath, join(here, 'fixtures', 'fake-acp.mjs')],
        piCommand: [process.execPath, join(here, 'fixtures', 'fake-pi.mjs')],
        agyCommand: [process.execPath, join(here, 'fixtures', 'fake-agy.mjs')],
        traexCommand: [process.execPath, join(here, 'fixtures', 'fake-acp.mjs'), 'acp', 'serve'],
      }),
    ],
    null,
  );
  const withRegistry = createHttpServer({ manager: new ThreadManager(store, registry.adapters, [workdir], new AttachmentStore(dataDir)), registry, token: TOKEN, webDir: null, version: 'test' });
  await new Promise<void>((r) => withRegistry.listen(0, '127.0.0.1', () => r()));
  const { port } = withRegistry.address() as AddressInfo;
  const regBase = `http://127.0.0.1:${port}`;
  const regApi = (path: string, init: RequestInit = {}) =>
    fetch(regBase + path, { ...init, headers: { 'Content-Type': 'application/json', ...auth, ...(init.headers ?? {}) } });

  // A second pi account, same CLI, its own environment.
  const added = await regApi('/api/agents', {
    method: 'POST',
    body: JSON.stringify({ id: 'pi2', adapter: 'pi', label: 'pi 备用', command: [process.execPath, join(here, 'fixtures', 'fake-pi.mjs')], env: { FAKE_PI_LABEL: 'pi2' } }),
  });
  assert.equal(added.status, 201);
  const listed = (await (await regApi('/api/agents')).json()) as Array<{ id: string; label: string; available: boolean }>;
  const second = listed.find((a) => a.id === 'pi2');
  assert.ok(second?.available);
  assert.equal(second.label, 'pi 备用');

  // The instance runs with its own environment: the fake pi says so in its reply.
  const made = (await (await regApi('/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi2', cwd: workdir }) })).json()) as { id: string };
  await regApi(`/api/threads/${made.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'hello' }) });
  const said = await waitFor(async () => {
    const log = (await (await regApi(`/api/threads/${made.id}/events`)).json()) as Array<{ type: string; data: any }>;
    const done = log.some((e) => e.type === 'turn.done');
    return done ? log.filter((e) => e.type === 'message.delta').map((e) => String(e.data.text)).join('') : null;
  });
  assert.match(said, /\[pi2\] there hello/);

  // PATH discovery: an agy2 shim is offered; a lookalike is not.
  const bin = join(dataDir, 'discover-bin');
  mkdirSync(bin);
  for (const name of ['agy2', 'ping']) {
    writeFileSync(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${join(here, 'fixtures', 'fake-agy.mjs')}" "$@"\n`, { mode: 0o755 });
  }
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const found = (await (await regApi('/api/agents/discover')).json()) as Array<{ id: string; adapter: string; command: string }>;
    const ours = found.filter((f) => f.command.startsWith(bin));
    assert.deepEqual(ours.map((f) => f.id), ['agy2']);
    assert.equal(ours[0].adapter, 'agy');
  } finally {
    process.env.PATH = oldPath;
  }
  withRegistry.close();
});

test('events endpoint: tail loads the newest stretch, before pages older history', async () => {
  const thread = await (await api('/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: workdir }) })).json();
  for (let i = 1; i <= 30; i++) store.appendEvent(thread.id, null, 'thread.updated', { i });
  // Creating the thread itself wrote seq 1 (thread.created); the 30 appended ones follow.
  const all = (await (await api(`/api/threads/${thread.id}/events?after=0`)).json()) as Array<{ seq: number }>;
  assert.equal(all.length, 31);

  // The tail is the END of the log, in order — what a reopened page renders first.
  const tail = (await (await api(`/api/threads/${thread.id}/events?tail=10`)).json()) as Array<{ seq: number }>;
  assert.deepEqual(tail.map((e) => e.seq), [22, 23, 24, 25, 26, 27, 28, 29, 30, 31]);

  // Paging walks backwards from the oldest seq the page already has, staying in order.
  const page = (await (await api(`/api/threads/${thread.id}/events?before=22&limit=10`)).json()) as Array<{ seq: number }>;
  assert.deepEqual(page.map((e) => e.seq), [12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
  const page2 = (await (await api(`/api/threads/${thread.id}/events?before=12&limit=10`)).json()) as Array<{ seq: number }>;
  assert.deepEqual(page2.map((e) => e.seq), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  // Fewer events than the page size: just what exists.
  const page3 = (await (await api(`/api/threads/${thread.id}/events?before=4&limit=10`)).json()) as Array<{ seq: number }>;
  assert.deepEqual(page3.map((e) => e.seq), [1, 2, 3]);
  // Unknown thread still 404s.
  assert.equal((await api('/api/threads/nope/events?tail=10')).status, 404);
});
