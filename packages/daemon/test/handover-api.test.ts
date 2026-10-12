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
  const root = mkdtempSync(join(tmpdir(), 'rah-handover-api-'));
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
      assert.match(empty.summary,/尚未创建/);
      assert.ok(empty.summary.includes(accounts[i]));
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
      for (const value of [`实例 ID：claude-${i+1}`, `项目工作目录（cwd）：${cwd}`, `Agent 配置/数据目录：${accounts[i]}`, `Session ID：shared-session-id`, `Session 文件地址：${session}`, 'CLAUDE_CONFIG_DIR=', '继续完成测试']) assert.ok(result.summary.includes(value), value);
      assert.ok(!result.summary.includes(accounts[1-i]));
      assert.doesNotMatch(result.summary,/never-copy-this|ANTHROPIC_API_KEY|FAKE_SESSION_ROOT/);
      assert.deepEqual(manager.listEventsSince(thread.id,0),eventsBefore);
      assert.equal(readFileSync(session,'utf8'),fileBefore);
      if (i === 1) {
        await api(`/api/threads/${thread.id}/turns`, {text:'slow'});
        const running = await api(`/api/threads/${thread.id}/handover`);
        assert.equal(running.status,200,'works while the source is running');
        assert.ok((await running.json() as {summary:string}).summary.includes('实例 ID：claude-2'));
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
    for (const value of [`项目工作目录（cwd）：${subdir}`,`当前 worktree：${tree}`,'当前分支：existing',`主仓库（仅供定位）：${cwd}`,'沿用同一个 worktree','不要要求用户重新配置工作目录或手动新开会话']) assert.ok(summary.summary.includes(value),value);
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
  const root = mkdtempSync(join(tmpdir(), 'rah-handover-start-'));
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
    assert.deepEqual(next.handover,{sourceId:source.id,title:source.title,agent:source.agent});
    assert.deepEqual(store.getThread(next.id)?.handover,next.handover);
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
