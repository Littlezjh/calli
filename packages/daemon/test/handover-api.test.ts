import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { AgentRegistry } from '../src/agents.js';
import { AttachmentStore } from '../src/attachments.js';
import { createHttpServer } from '../src/http.js';
import { Store } from '../src/store.js';
import { ThreadManager } from '../src/threads.js';
import { Workdirs } from '../src/workdirs.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-acp.mjs');

test('handover GET assembles exact Claude instance and session coordinates without spending a turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'calli-handover-api-'));
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  const accounts = [join(root, 'account-one'), join(root, 'account-two')];
  const registry = new AgentRegistry(accounts.map((dir, i) => ({
    id: `claude-${i + 1}`, adapter: 'claude', label: 'Claude Code',
    command: [process.execPath, fixture],
    env: { CLAUDE_CONFIG_DIR: dir, FAKE_SESSION_ROOT: dir, FAKE_ACP_SESSION: 'shared-session-id', ANTHROPIC_API_KEY: 'never-copy-this' },
  })), null);
  const store = new Store(join(root, 'data'));
  const manager = new ThreadManager(store, registry.adapters, new Workdirs([cwd], null), new AttachmentStore(join(root, 'data')));
  const server = createHttpServer({manager, token:'handover-test-token', webDir:null, version:'test'});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (path: string, body?: unknown) => fetch(base + path, { method:body ? 'POST':'GET', headers: {Authorization:'Bearer handover-test-token','Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {}) });
  try {
    for (let i = 0; i < accounts.length; i++) {
      const created = await api('/api/threads', {agent:`claude-${i+1}`,cwd,title:'同名 Claude 的交接'});
      const thread = await created.json() as {id:string};
      const empty = await (await api(`/api/threads/${thread.id}/handover`)).json() as {summary:string};
      // The clean brief of the auto handover: no coordinates to leak, just where to look.
      assert.match(empty.summary,/# 接手/);
      assert.ok(empty.summary.includes(cwd), 'the working directory is in it');
      assert.ok(empty.summary.includes(`calli history ${thread.id}`));
      assert.equal((await api(`/api/threads/${thread.id}/turns`, {text:'继续完成测试'})).status,202);
      let ready = false;
      for (let n=0;n<100;n++) {
        if (manager.getThread(thread.id).status === 'idle') { ready = true; break; }
        await new Promise((r)=>setTimeout(r,25));
      }
      assert.ok(ready);
      const eventsBefore = manager.listEventsSince(thread.id,0);
      const session = join(accounts[i], 'projects', cwd.replace(/[^a-zA-Z0-9]/g,'-'), 'shared-session-id.jsonl');
      const fileBefore = readFileSync(session,'utf8');
      const result = await (await api(`/api/threads/${thread.id}/handover`)).json() as {summary:string};
      for (const value of ['# 接手', `calli history ${thread.id}`, '继续完成测试', '## 进度（hub 从记录整理，可能不全）']) assert.ok(result.summary.includes(value), value);
      assert.doesNotMatch(result.summary,/never-copy-this|ANTHROPIC_API_KEY|FAKE_SESSION_ROOT|account-/, 'neither account\u2019s coordinates or secrets appear');
      assert.deepEqual(manager.listEventsSince(thread.id,0),eventsBefore);
      assert.equal(readFileSync(session,'utf8'),fileBefore);
      if (i === 1) {
        await api(`/api/threads/${thread.id}/turns`, {text:'slow'});
        const running = await api(`/api/threads/${thread.id}/handover`);
        assert.equal(running.status,200,'works while the source is running');
        assert.ok((await running.json() as {summary:string}).summary.includes(`calli history ${thread.id}`));
      }
    }
    // An existing worktree may predate the hub and have no hub worktree metadata.
    const git = (args: string[]) => execFileSync('git', args, { cwd, stdio:'pipe' });
    git(['init','-q']);
    git(['-c','user.name=Test','-c','user.email=test@example.com','-c','commit.gpgsign=false','commit','--allow-empty','-qm','initial']);
    const tree = join(cwd,'.worktrees','existing');
    git(['worktree','add','-b','existing',tree]);
    const subdir = join(tree,'src');
    mkdirSync(subdir);
    const created = await api('/api/threads',{agent:'claude-1',cwd:subdir});
    assert.equal(created.status,201);
    const thread = await created.json() as {id:string};
    const summary = await (await api(`/api/threads/${thread.id}/handover`)).json() as {summary:string};
    // The brief carries the working place as one line, worktree and branch included.
    assert.ok(summary.summary.includes(`工作目录 ${subdir}（worktree ${tree}，分支 existing）`), summary.summary);
    assert.match(summary.summary, /沿用它和未提交的改动/);
    assert.equal(git(['branch','--show-current']).toString().trim() === 'existing',false,'the main checkout was not switched');
    assert.equal((await fetch(base+'/api/threads/nope/handover')).status,401);
    assert.equal((await api('/api/threads/nope/handover')).status,404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r)=>server.close(()=>r()));
    await manager.shutdown();
    store.close();
    rmSync(root,{recursive:true,force:true});
  }
});


test('handover-thread creates an unsent conversation in the same worktree, including scratch and external checkouts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'calli-handover-start-'));
  const cwd = join(root, 'project');
  const scratch = join(root, 'scratch');
  mkdirSync(cwd);
  const git = (args: string[]) => execFileSync('git', args, {cwd, stdio:'pipe'}).toString();
  git(['init','-q']);
  writeFileSync(join(cwd,'task.txt'),'original\n');
  git(['add','.']);
  git(['-c','user.name=Test','-c','user.email=test@example.com','-c','commit.gpgsign=false','commit','-qm','initial']);
  const registry = new AgentRegistry(['source','successor'].map((name) => ({
    id:name, adapter:'claude', label:'Claude '+name, command:[process.execPath,fixture],
    env:{CLAUDE_CONFIG_DIR:join(root,name),FAKE_SESSION_ROOT:join(root,name),FAKE_ACP_SESSION:name+'-session'},
  })),null);
  const store = new Store(join(root,'data'));
  const manager = new ThreadManager(store,registry.adapters,new Workdirs([cwd],null,scratch),new AttachmentStore(join(root,'data')));
  const server = createHttpServer({manager,token:'handover-test-token',webDir:null,version:'test'});
  await new Promise<void>((r)=>server.listen(0,'127.0.0.1',r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (path: string, body?: unknown) => fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer handover-test-token','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  try {
    const section = manager.createSection('待完成');
    const source = await manager.createThread({agent:'source',cwd,title:'原任务',sectionId:section.id,worktree:true});
    writeFileSync(join(source.cwd,'task.txt'),'keep these changes\n');
    writeFileSync(join(source.cwd,'unsaved.txt'),'keep me too\n');
    const checkoutBefore = git(['worktree','list','--porcelain']);
    const eventsBefore = manager.listEventsSince(source.id,0);
    const res = await api(`/api/threads/${source.id}/handover-thread`,{agent:'successor',cwd:root,worktree:true});
    assert.equal(res.status,201);
    const next = await res.json() as ReturnType<ThreadManager['threadView']>;
    assert.notEqual(next.id,source.id);
    assert.equal(next.agent,'successor');
    assert.equal(next.cwd,source.cwd,'client cannot redirect the successor to another directory');
    assert.deepEqual(next.worktree,source.worktree);
    assert.equal(next.sectionId,source.sectionId);
    assert.equal(next.agentSessionId,null);
    assert.equal(next.forkedFrom,null,'handover does not copy the native session');
    assert.deepEqual(next.handover,{sourceId:source.id,title:source.title,agent:source.agent,mode:'branch',automatic:false,sourceMoved:false,sourceSeq:eventsBefore.at(-1)?.seq ?? 0});
    const { automatic, sourceMoved, ...storedLink } = next.handover;
    assert.equal(automatic, false);
    assert.equal(sourceMoved, false);
    assert.deepEqual(store.getThread(next.id)?.handover, storedLink);
    assert.equal(next.status,'idle');
    assert.equal(next.title,'原任务（接手）');
    assert.equal(manager.listEventsSince(next.id,0).some(e=>e.type==='turn.started'),false);
    assert.deepEqual(manager.listEventsSince(source.id,0),eventsBefore);
    assert.equal(existsSync(join(root,'successor','projects')),false,'the successor agent has not run');
    assert.equal(git(['worktree','list','--porcelain']),checkoutBefore);
    assert.equal(readFileSync(join(next.cwd,'task.txt'),'utf8'),'keep these changes\n');
    assert.equal(readFileSync(join(next.cwd,'unsaved.txt'),'utf8'),'keep me too\n');
    await assert.rejects(manager.deleteThread(source.id,{worktree:true,force:true}),/another thread still runs/);
    await assert.rejects(manager.deleteThread(next.id,{worktree:true,force:true}),/another thread still runs/);
    assert.equal((await api(`/api/threads/${next.id}/turns`,{text:'edited handover'})).status,202);
    for(let n=0;n<100 && manager.getThread(next.id).status==='running';n++) await new Promise(r=>setTimeout(r,20));
    assert.equal(manager.getThread(next.id).status,'idle');
    assert.equal(manager.getThread(next.id).agentSessionId,'successor-session');
    const nativePath=join(root,'successor','projects',source.cwd.replace(/[^a-zA-Z0-9]/g,'-'),'successor-session.jsonl');
    assert.ok(existsSync(nativePath),'new agent session uses the exact source worktree');
    assert.deepEqual(manager.listEventsSince(source.id,0),eventsBefore);

    // A normal directory and an externally-created worktree subdirectory are also kept exactly.
    const external=join(cwd,'.worktrees','external');git(['worktree','add','-b','external',external]);
    const subdir=join(external,'src');mkdirSync(subdir);
    for(const location of [cwd,subdir]) {
      const original=await manager.createThread({agent:'source',cwd:location});
      const created=await api(`/api/threads/${original.id}/handover-thread`,{agent:'source'});
      assert.equal(created.status,201,'the same agent instance may start an independent conversation');
      const successor=await created.json() as ReturnType<ThreadManager['threadView']>;
      assert.equal(successor.cwd,location);assert.equal(successor.agentSessionId,null);
    }
    const outside=await manager.createThread({agent:'source',cwd:'',scratch:true});
    const resumed=await manager.createHandoverThread(outside.id,'successor');
    assert.equal(resumed.cwd,outside.cwd);assert.equal(resumed.scratch,true);

    const count=manager.listThreads().length;
    assert.equal((await fetch(base+`/api/threads/${source.id}/handover-thread`,{method:'POST',body:'{}'})).status,401);
    assert.equal((await api('/api/threads/missing/handover-thread',{agent:'successor'})).status,404);
    assert.equal((await api(`/api/threads/${source.id}/handover-thread`,{agent:'missing'})).status,400);
    assert.equal((await api(`/api/threads/${source.id}/handover-thread`,{})).status,400);
    assert.equal(manager.listThreads().length,count,'invalid requests leave no empty thread');
  } finally {
    server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
    await manager.shutdown();store.close();rmSync(root,{recursive:true,force:true});
  }
});

test('a turn that fails because the plan ran out is marked so another agent can take over', async () => {
  const root = mkdtempSync(join(tmpdir(), 'calli-plan-exhausted-'));
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  const registry = new AgentRegistry([{ id: 'claude', adapter: 'claude', label: 'Claude Code', command: [process.execPath, fixture], env: { CLAUDE_CONFIG_DIR: join(root, 'claude'), FAKE_SESSION_ROOT: join(root, 'claude') } }], null);
  const store = new Store(join(root, 'data'));
  const manager = new ThreadManager(store, registry.adapters, new Workdirs([cwd], null), new AttachmentStore(join(root, 'data')));
  try {
    const thread = await manager.createThread({ agent: 'claude', cwd });
    const ended = async () => {
      for (let n = 0; n < 200 && manager.getThread(thread.id).status === 'running'; n++) await new Promise((r) => setTimeout(r, 25));
      return manager.listEventsSince(thread.id, 0).filter((e) => e.type === 'turn.error').at(-1);
    };
    await manager.startTurn(thread.id, { text: 'out of plan' });
    const error = await ended();
    assert.equal(error?.data.code, 'plan_exhausted');
    assert.match(String(error?.data.message), /session limit/);
    // Any other failure keeps no code: the button is only for a plan that ran out.
    assert.equal(registry.adapters.get('claude')!.planExhausted!('Internal error'), false);
  } finally {
    await manager.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('merged-history HTTP reads omit handover text until explicitly expanded, and require authentication', async () => {
  const root = mkdtempSync(join(tmpdir(), 'calli-handover-history-'));
  const store = new Store(root);
  const registry = new AgentRegistry([{ id: 'pi', adapter: 'pi', command: [process.execPath, fixture] }], null);
  const manager = new ThreadManager(store, registry.adapters, new Workdirs([root], null), new AttachmentStore(root));
  const server = createHttpServer({ manager, token: 'history-token', webDir: null, version: 'test' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string) => fetch(base + path, { headers: { Authorization: 'Bearer history-token' } });
  try {
    const make = (id: string, sourceId?: string) => store.createThread({ id, agent: 'pi', cwd: root, title: id, agentSessionId: null, permissionMode: 'default', model: null, effort: null,
      handover: sourceId ? { sourceId, agent: 'pi', title: sourceId, mode: 'continue', sourceSeq: 2 } : null });
    make('source'); make('recipient', 'source');
    store.appendEvent('source', 'last', 'turn.started', { text: 'continue' });
    store.appendEvent('source', 'last', 'turn.error', { code: 'plan_exhausted', message: 'limit' });
    store.appendEvent('recipient', 'opening', 'turn.started', { text: 'original', displayText: 'received handover' });
    store.appendEvent('recipient', 'opening', 'message.delta', { text: 'answer' });
    store.appendEvent('recipient', 'opening', 'turn.done', {});
    const path = '/api/threads/recipient/history';
    assert.equal((await fetch(base + path + '/handover')).status, 401);
    const collapsed = await (await get(path + '?chain=1')).json() as {events: {data: Record<string, unknown>}[]};
    assert.ok(!JSON.stringify(collapsed).includes('received handover'));
    assert.ok(collapsed.events.some(event => event.data.handoverCollapsed === true));
    const metadata = await (await get(path + '/handover')).json() as Record<string, unknown>;
    assert.equal('text' in metadata, false); assert.equal(metadata.reason, 'plan_exhausted');
    const expanded = await (await get(path + '/handover?text=1')).json() as { text: string };
    assert.equal(expanded.text, 'received handover');
    assert.ok((await (await get(path)).text()).includes('received handover'));
    store.appendEvent('source', 'summary-turn', 'turn.started', { text: 'summary prompt', handover: 'pi2' });
    store.appendEvent('source', 'summary-turn', 'message.delta', { text: 'summary answer' });
    store.appendEvent('source', 'summary-turn', 'turn.done', {});
    const summaryPath = '/api/threads/source/history/summary?turn=summary-turn';
    assert.equal((await fetch(base + summaryPath)).status, 401);
    assert.equal((await get('/api/threads/source/history/summary')).status, 400);
    assert.equal((await get('/api/threads/source/history/summary?turn=missing')).status, 404);
    const summary = await (await get(summaryPath)).json() as any;
    assert.equal(summary.prompt, 'summary prompt'); assert.equal(summary.text, 'summary answer');
    assert.equal((await get(summaryPath + '&cursor=-1')).status, 400);
    assert.equal((await get('/api/threads/source/history/handover')).status, 404);
    assert.equal((await get('/api/threads/missing/history/handover')).status, 404);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await manager.shutdown(); store.close(); rmSync(root, { recursive: true, force: true });
  }
});


test('manual handovers always branch without stopping work, automatic handovers continue, and resumed sources separate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'calli-handover-mode-'));
  const store = new Store(root);
  const registry = new AgentRegistry(['source', 'next'].map(id => ({ id, adapter: 'claude', command: [process.execPath, fixture] })), null);
  const manager = new ThreadManager(store, registry.adapters, new Workdirs([root], null), new AttachmentStore(root));
  const server = createHttpServer({ manager, token: 'mode-token', webDir: null, version: 'test' });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (id: string, mode?: unknown, agent = 'next') => fetch(`${base}/api/threads/${id}/handover-thread`, { method: 'POST', headers: { Authorization: 'Bearer mode-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ agent, ...(mode === undefined ? {} : { mode }) }) });
  try {
    const source = await manager.createThread({ agent: 'source', cwd: root });
    await manager.startTurn(source.id, { text: 'slow work' });
    for (let i = 0; i < 200 && !manager.listEventsSince(source.id, 0).some(e => e.type === 'message.delta'); i++) await new Promise(r => setTimeout(r, 10));
    assert.equal((await post(source.id, 'wrong')).status, 400);
    assert.equal((await post(source.id, 'continue', 'missing')).status, 400);
    assert.equal(manager.threadView(source.id).status, 'running', 'invalid requests never stop work');
    const branch = await (await post(source.id)).json() as any;
    assert.equal(branch.handover.mode, 'branch');
    assert.equal(store.getThread(branch.id)!.handover?.mode, 'branch');
    assert.equal(manager.threadView(source.id).status, 'running');
    const idleManual = await (await post(branch.id)).json() as any;
    assert.equal(idleManual.handover.mode, 'branch', 'idle manual handovers remain independent');
    assert.equal(branch.handover.automatic, false);
    await manager.cancelTurn(source.id);
    for (let i = 0; i < 200 && manager.threadView(source.id).status === 'running'; i++) await new Promise(r => setTimeout(r, 10));
    const continued = await (await post(source.id, 'continue')).json() as any;
    assert.equal(continued.handover.automatic, true);
    assert.equal(continued.handover.mode, 'continue');
    assert.equal(manager.threadView(source.id).status, 'idle');
    assert.ok(manager.listEventsSince(source.id, 0).some(e => e.type === 'turn.done' && e.data.stopReason === 'cancelled'));
    const next = await (await post(continued.id, 'continue')).json() as any;
    assert.equal(next.handover.mode, 'continue', 'automatic handovers explicitly continue');
    const independent = await (await post(continued.id, 'branch')).json() as any;
    assert.equal(independent.handover.mode, 'branch', 'idle sessions may also branch');
    const stored = JSON.stringify(store.getThread(continued.id)!.handover);
    // Even identical wall-clock timestamps cannot hide a new turn after the source boundary.
    store.appendEvent(source.id, 'restarted', 'turn.started', { text: 'another task' });
    assert.equal(manager.threadView(continued.id).handover?.mode, 'branch');
    assert.equal(manager.threadView(continued.id).handover?.automatic, true, 'history preserves how the handover began');
    assert.equal(manager.listThreads().find(t => t.id === continued.id)!.handover?.mode, 'branch');
    assert.equal(manager.threadView(next.id).handover?.mode, 'continue', 'only the resumed edge changes');
    assert.equal(JSON.stringify(store.getThread(continued.id)!.handover), stored, 'derivation never rewrites the relation');
    const detachedResponse = await fetch(`${base}/api/threads/${next.id}/handover-link`, { method: 'DELETE', headers: { Authorization: 'Bearer mode-token' } });
    assert.equal(detachedResponse.status, 200);
    assert.deepEqual((await detachedResponse.json() as any).detached, [next.id]);
    assert.equal(manager.threadView(next.id).handover?.mode, 'branch');
    assert.equal(manager.threadView(next.id).handover?.automatic, true, 'the record still says this began automatically');
    assert.equal(store.getThread(next.id)!.handover?.mode, 'continue');
    assert.equal(store.getThread(next.id)!.handover?.detached, true);
    assert.equal(manager.threadView(continued.id).autoHandover?.override, false, 'only the restored source stops handing over');
    assert.equal(manager.threadView(next.id).autoHandover?.override, null);
    assert.equal(manager.threadView(source.id).autoHandover?.override, null);
    assert.equal((await fetch(`${base}/api/threads/${next.id}/handover-link`, { method: 'DELETE', headers: { Authorization: 'Bearer mode-token' } })).status, 409);
    // A handover made by hand only leaves its chain: both conversations stay, nothing is archived.
    const manualDetach = await fetch(`${base}/api/threads/${independent.id}/handover-link`, { method: 'DELETE', headers: { Authorization: 'Bearer mode-token' } });
    assert.equal(manualDetach.status, 200);
    assert.deepEqual((await manualDetach.json() as any).detached, [independent.id]);
    assert.equal(store.getThread(independent.id)!.handover?.detached, true);
    assert.equal(store.getThread(independent.id)!.archivedAt, null);
    assert.equal(manager.threadView(continued.id).autoHandover?.override, false, 'unchanged by the manual unlink');
    assert.equal((await fetch(`${base}/api/threads/${independent.id}/handover-link`, { method: 'DELETE', headers: { Authorization: 'Bearer mode-token' } })).status, 409);
    const forkedSource = await manager.createThread({ agent: 'source', cwd: root });
    const forkOne = await manager.createHandoverThread(forkedSource.id, 'next', undefined, 'continue');
    const forkTwo = await manager.createHandoverThread(forkedSource.id, 'next', undefined, 'continue');
    const forkDetach = await fetch(`${base}/api/threads/${forkedSource.id}/handover-link`, { method: 'DELETE', headers: { Authorization: 'Bearer mode-token' } });
    assert.deepEqual(new Set((await forkDetach.json() as any).detached), new Set([forkOne.id, forkTwo.id]), 'all direct successors split so none keeps the source read-only');
    assert.equal(manager.threadView(forkOne.id).handover?.mode, 'branch');
    assert.equal(manager.threadView(forkTwo.id).handover?.mode, 'branch');
    assert.equal(manager.threadView(forkedSource.id).autoHandover?.override, false);
    assert.equal(manager.threadView(forkOne.id).autoHandover?.override, null);
    assert.equal(manager.threadView(forkTwo.id).autoHandover?.override, null);
    const legacy = store.createThread({ id: 'legacy', agent: 'next', cwd: root, title: 'legacy', permissionMode: 'default', model: null, effort: null, handover: { sourceId: source.id, title: 'source', agent: 'source' } });
    assert.equal(manager.threadView(legacy.id).handover?.mode, 'branch');
    assert.equal(store.getThread(legacy.id)!.handover?.mode, undefined);
    store.appendEvent(legacy.id, 'opening', 'turn.started', { text: 'branch context' });
    assert.ok(JSON.stringify(await store.history.page(legacy.id, undefined, 0, false)).includes('branch context'), 'read on its own, the branch context is not hidden');
    assert.ok(!JSON.stringify(await store.history.page(legacy.id, undefined, 0, true)).includes('branch context'), 'read as part of a chain it is the folded card of the boundary');
  } finally {
    await manager.shutdown(); await new Promise<void>(r => server.close(() => r())); store.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('a relay between accounts of the same agent keeps model and effort; across agent kinds it does not', async () => {
  const root = mkdtempSync(join(tmpdir(), 'calli-handover-model-'));
  const cwd = join(root, 'project'); mkdirSync(cwd);
  const one = join(root, 'one'), two = join(root, 'two');
  const fakeAgy = join(dirname(fixture), 'fake-agy.mjs');
  const registry = new AgentRegistry([
    { id: 'claude-1', adapter: 'claude', label: 'Claude Code', command: [process.execPath, fixture], env: { CLAUDE_CONFIG_DIR: one, FAKE_SESSION_ROOT: one } },
    { id: 'claude-2', adapter: 'claude', label: 'Claude Code', command: [process.execPath, fixture], env: { CLAUDE_CONFIG_DIR: two, FAKE_SESSION_ROOT: two } },
    { id: 'agy-x', adapter: 'agy', label: 'Antigravity', command: [process.execPath, fakeAgy], env: {} },
    { id: 'claude-gw', adapter: 'claude', label: 'Claude Code', command: [process.execPath, fixture], env: { CLAUDE_CONFIG_DIR: two, FAKE_SESSION_ROOT: two } },
  ], null);
  const store = new Store(join(root, 'data'));
  const manager = new ThreadManager(store, registry.adapters, new Workdirs([cwd], null), new AttachmentStore(join(root, 'data')));
  // A gateway account of the same agent serves a model the subscription accounts do not have.
  const gateway = registry.adapters.get('claude-gw')!;
  const own = gateway.models.bind(gateway);
  gateway.models = async (refresh) => [...await own(refresh), { id: 'zcode/GLM-5.3', label: 'GLM-5.3' }];
  try {
    const source = await manager.createThread({ agent: 'claude-1', cwd, model: 'big', effort: 'high' });
    // Same agent, another account: the relay keeps what the thread was running.
    const relay = await manager.createHandoverThread(source.id, 'claude-2');
    assert.equal(relay.model, 'big');
    assert.equal(relay.effort, 'high');
    // A different agent kind has its own model names; it keeps its own default.
    const across = await manager.createHandoverThread(source.id, 'agy-x');
    assert.equal(across.model, null);
    assert.equal(across.effort, null);
    // An explicit choice still wins over the inheritance.
    const pinned = await manager.createHandoverThread(source.id, 'claude-2', 'small');
    assert.equal(pinned.model, 'small');
    // Same agent, but the target does not offer the model: it starts on its own default instead of failing.
    const routed = await manager.createThread({ agent: 'claude-gw', cwd, model: 'zcode/GLM-5.3' });
    const toPlan = await manager.createHandoverThread(routed.id, 'claude-1');
    assert.equal(toPlan.model, null);
  } finally { await manager.shutdown(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a gateway plan running out switches the same thread to a separately billed model and resends the ask', async () => {
  const { modelGateway } = await import('./fixtures/model-gateway.mjs');
  const gateway = await modelGateway();
  const root = mkdtempSync(join(tmpdir(), 'calli-gateway-switch-'));
  let manager: ThreadManager | undefined;
  try {
    gateway.state.models = [
      { id: 'zcode/GLM-5.3', display_name: 'zcode/GLM-5.3' },
      { id: 'deepseek/deepseek-flash', display_name: 'deepseek/deepseek-flash' },
    ];
    const account = join(root, 'account');
    mkdirSync(account);
    writeFileSync(join(account, 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: gateway.url, ANTHROPIC_AUTH_TOKEN: 'gateway-test-token', CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1' },
      model: 'zcode/GLM-5.3',
    }));
    const selected = join(root, 'models-selected.log');
    const registry = new AgentRegistry([{
      id: 'magpie', adapter: 'claude', label: 'Claude Code', command: [process.execPath, fixture],
      // The fake agent's catalog mirrors the gateway's: one plan model, one routed provider.
      env: {
        CLAUDE_CONFIG_DIR: account, ANTHROPIC_BASE_URL: gateway.url, CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
        FAKE_ACP_MODELS: 'zcode/GLM-5.3|GLM-5.3,deepseek/deepseek-flash|DeepSeek-V4.1-Flash', FAKE_ACP_MODEL_SELECTION_LOG: selected,
      },
    }], null);
    const store = new Store(join(root, 'data'));
    const cwd = join(root, 'project'); mkdirSync(cwd);
    manager = new ThreadManager(store, registry.adapters, new Workdirs([cwd], null), new AttachmentStore(join(root, 'data')), () => [{ id: 'magpie', adapter: 'claude' }]);
    Object.defineProperty(manager.autoHandover, 'delayMs', { value: 80 });
    const adapter = registry.adapters.get('magpie')!;
    adapter.fetchQuota = () => Promise.resolve({ windows: [], checkedAt: new Date().toISOString() });

    const thread = await manager.createThread({ agent: 'magpie', cwd, model: 'zcode/GLM-5.3' });
    store.updateThread(thread.id, { permissionMode: 'full_access' });
    // The order names the routed model, which the adapter's ids prove bills on its own provider.
    manager.autoHandover.configure({ enabled: true, threshold: 90, orders: { magpie: [{ agent: 'magpie', model: 'deepseek/deepseek-flash' }] } });
    assert.deepEqual(await manager.autoHandover.targets(thread.id), [{ agent: 'magpie', model: 'deepseek/deepseek-flash' }]);

    await manager.startTurn(thread.id, { text: 'out of plan' });
    const wait = async (check: () => unknown, timeout = 20_000) => {
      const end = Date.now() + timeout;
      while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 25)); }
    };
    await wait(() => manager.threadView(thread.id).status === 'idle' && !manager.autoHandover.held(thread.id));

    // One conversation, on the other model now, the failed ask sent again and answered.
    assert.equal(manager.listThreads().length, 1);
    assert.equal(manager.getThread(thread.id).model, 'deepseek/deepseek-flash');
    const turns = store.listTurns(thread.id);
    assert.equal(turns.length, 2);
    assert.equal(store.listEvents(thread.id, 0, -1).filter(e => e.type === 'turn.error').length, 1);
    const switched = store.listEvents(thread.id, 0, -1).find(e => e.type === 'handover.model');
    assert.deepEqual({ model: switched?.data.model, previous: switched?.data.previous, reason: switched?.data.reason },
      { model: 'deepseek/deepseek-flash', previous: 'zcode/GLM-5.3', reason: 'exhausted' });
    // The agent really ran the resend on the routed model, not only had its name changed.
    assert.deepEqual(readFileSync(selected, 'utf8').trim().split('\n'), ['zcode/GLM-5.3', 'deepseek/deepseek-flash']);
  } finally {
    await manager?.shutdown().catch(() => undefined);
    await gateway.close();
    rmSync(root, { recursive: true, force: true });
  }
});
