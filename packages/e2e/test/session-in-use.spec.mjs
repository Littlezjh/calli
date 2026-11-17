import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {api,launchBrowser,openUi,repoRoot,startDaemon} from '../harness.mjs';

async function waitForThread(daemon,id,status){
  for(let i=0;i<200;i++){
    const thread=await(await api(daemon,`/api/threads/${id}`)).json();
    if(thread.status===status)return thread;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw new Error(`thread did not become ${status}`);
}

test('writer conflicts replace the composer, survive reload, retry after release and fork independently', {timeout:120_000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'calli-writer-conflict-e2e-'));
  const lock=join(dir,'writer');
  const daemon=await startDaemon({CALLI_AGENTS_JSON:JSON.stringify({agents:[{
    id:'codex',adapter:'codex',command:[process.execPath,join(repoRoot,'daemon/test/fixtures/fake-codex.mjs')],
    env:{FAKE_CODEX_WRITER_LOCK:lock,FAKE_CODEX_WRITER_LOCK_PHASE:'prompt',FAKE_CODEX_WRITER_LOCK_THREAD:'codex-thread-1'},
  }]})});
  let browser;
  try{
    browser=await launchBrowser();
    for(const phone of [false,true])for(const theme of ['light','dark']){
      writeFileSync(lock,'busy');
      const title=`会话占用 ${phone?'手机':'桌面'} ${theme}`;
      const thread=await(await api(daemon,'/api/threads',{method:'POST',body:JSON.stringify({agent:'codex',cwd:daemon.workdir,title})})).json();
      await api(daemon,`/api/threads/${thread.id}/turns`,{method:'POST',body:JSON.stringify({text:'hello'})});
      assert.equal((await waitForThread(daemon,thread.id,'error')).failure.code,'session_in_use');
      const context=await browser.newContext({viewport:phone?{width:390,height:844}:{width:1440,height:1000},hasTouch:phone,isMobile:phone,colorScheme:theme,locale:'zh-CN',reducedMotion:'reduce'});
      try{
        await context.addInitScript(()=>{localStorage.setItem('calli.pet.presence','off');localStorage.setItem('calli_onboard_dismissed','1')});
        const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
        await openUi(page,daemon);
        if(phone)await page.locator('.menu-btn').click();
        await page.locator('.thread-item',{hasText:title}).click();
        const notice=page.locator('.session-in-use-notice');
        await notice.getByText('已在另一个应用中打开',{exact:true}).waitFor();
        assert.equal(await page.locator('.composer-slot textarea').count(),0,'the locked session cannot accept a prompt');
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        if(process.env.CALLI_E2E_SCREENSHOTS_DIR){mkdirSync(process.env.CALLI_E2E_SCREENSHOTS_DIR,{recursive:true});await page.screenshot({path:join(process.env.CALLI_E2E_SCREENSHOTS_DIR,`session-in-use-${phone?'phone':'desktop'}-${theme}.png`),animations:'disabled'})}
        await page.reload();
        if(phone)await page.locator('.menu-btn').click();
        await page.locator('.thread-item',{hasText:title}).click();
        await notice.waitFor();
        await notice.getByRole('button',{name:'创建聊天分叉',exact:true}).click();
        await notice.waitFor({state:'detached'});
        const threads=await(await api(daemon,'/api/threads')).json();
        const copy=threads.find(value=>value.forkedFrom===thread.id);
        assert.ok(copy,'fork creates a separate thread');
        await api(daemon,`/api/threads/${copy.id}/turns`,{method:'POST',body:JSON.stringify({text:'fork can continue'})});
        await waitForThread(daemon,copy.id,'idle');
        if(phone)await page.locator('.menu-btn').click();
        await page.locator('.thread-item',{hasText:title}).filter({hasNotText:'（分叉）'}).first().click();
        await notice.waitFor();
        rmSync(lock);
        await notice.getByRole('button',{name:'重试',exact:true}).click();
        await notice.waitFor({state:'detached'});
        await waitForThread(daemon,thread.id,'idle');
        assert.deepEqual(errors,[]);
      }finally{await context.close()}
    }
  }finally{await browser?.close();await daemon.stop();rmSync(dir,{recursive:true,force:true})}
});
