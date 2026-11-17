import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CodexAppServerAdapter} from '../src/adapters/codex.js';
import {Store} from '../src/store.js';
import {ThreadManager} from '../src/threads.js';
import {AttachmentStore} from '../src/attachments.js';

const fake=fileURLToPath(new URL('fixtures/fake-codex.mjs',import.meta.url));
async function wait(check:()=>boolean){
  for(let i=0;i<300;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,10))}
  throw new Error('thread did not settle');
}

test('Codex identifies an explicit writer conflict without confusing other failures',()=>{
  const adapter=new CodexAppServerAdapter([]);
  assert.equal(adapter.sessionInUse('thread 01a1e76a-c163-7201-8111-0b7fd6a2a635 already has an active writer'),true);
  for(const message of ['ActiveTurnNotSteerable','thread not found','usage limit exceeded','file is locked','another thread still runs in this worktree'])assert.equal(adapter.sessionInUse(message),false);
});

for(const phase of ['resume','prompt'])test(`writer conflict during ${phase} is persisted and can be retried after release`,async()=>{
  const root=mkdtempSync(join(tmpdir(),'calli-session-in-use-'));
  const lock=join(root,'external-writer');writeFileSync(lock,'busy');
  const store=new Store(root);
  const adapter=new CodexAppServerAdapter([process.execPath,fake],{FAKE_CODEX_WRITER_LOCK:lock,FAKE_CODEX_WRITER_LOCK_PHASE:phase});
  const manager=new ThreadManager(store,new Map([['codex',adapter]]),[root],new AttachmentStore(root));
  try{
    const thread=await manager.createThread({agent:'codex',cwd:root});
    if(phase==='resume')store.updateThread(thread.id,{agentSessionId:'codex-thread-1'});
    await manager.startTurn(thread.id,{text:'hello'});
    const queued=await manager.startTurn(thread.id,{text:'queued follow-up',queue:true});
    assert.ok('queued' in queued);
    await wait(()=>manager.threadView(thread.id).status==='error');
    const failure=manager.threadView(thread.id).failure;
    assert.equal(failure?.code,'session_in_use');
    assert.match(failure?.message??'',/already has an active writer/);
    assert.equal(store.lastTurnFailure(thread.id)?.code,'session_in_use');
    await new Promise(resolve=>setTimeout(resolve,60));
    assert.equal(manager.threadView(thread.id).queued.length,1,'writer conflicts pause queued sends');
    const turns=store.listTurns(thread.id).length;
    const stillLocked=await manager.retryFailedTurn(thread.id);
    assert.equal(stillLocked.failure?.code,'session_in_use');
    assert.equal(store.listTurns(thread.id).length,turns,'a retry while locked only checks ownership');
    rmSync(lock);
    await manager.retryFailedTurn(thread.id);
    await wait(()=>manager.threadView(thread.id).status==='idle' && manager.threadView(thread.id).queued.length===0);
    assert.equal(manager.threadView(thread.id).status,'idle');
    assert.equal(manager.threadView(thread.id).failure,null);
  }finally{await manager.shutdown();store.close();rmSync(root,{recursive:true,force:true})}
});
