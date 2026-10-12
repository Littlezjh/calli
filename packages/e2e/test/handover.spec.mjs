import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOnce, startDaemon, openUi, api, launchBrowser, repoRoot } from '../harness.mjs';

let root, daemon, browser, thread, configDir;
before(async () => {
  await buildOnce();
  root = mkdtempSync(join(tmpdir(),'rah-handover-e2e-'));
  configDir = join(root,'claude-work');
  daemon = await startDaemon({ RAH_AGENTS_JSON: JSON.stringify({ agents: [{
    id:'claude-work', adapter:'claude', label:'Claude 工作号', command:['fake-claude'],
    env:{CLAUDE_CONFIG_DIR:configDir,FAKE_SESSION_ROOT:configDir,FAKE_ACP_SESSION:'work-session'},
  }] }) });
  thread = await (await api(daemon,'/api/threads',{method:'POST',body:JSON.stringify({agent:'claude-work',cwd:daemon.workdir,title:'待交接的任务'})})).json();
  await api(daemon,`/api/threads/${thread.id}/turns`,{method:'POST',body:JSON.stringify({text:'修复登录页并补测试'})});
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); await daemon?.stop(); rmSync(root,{recursive:true,force:true}); });

for (const mobile of [false,true]) for (const theme of ['light','dark']) {
  test(`handover is ready to copy on opening: ${mobile?'phone':'desktop'} ${theme}`,async () => {
    const context = await browser.newContext({viewport: mobile?{width:390,height:844}:{width:1440,height:960}, isMobile:mobile,hasTouch:mobile,colorScheme:theme,permissions:['clipboard-read','clipboard-write']});
    const page = await context.newPage();
    try {
      await openUi(page,daemon);
      if (mobile) await page.locator('.menu-btn').click();
      await page.locator('.sidebar .thread-item',{hasText:'待交接的任务'}).click();
      await page.getByText('echo:修复登录页并补测试',{exact:true}).waitFor();
      assert.equal(await page.getByText('unknown agent: claude',{exact:true}).count(),0,'custom instance ids do not query a nonexistent default');
      const before = await (await api(daemon,`/api/threads/${thread.id}/events`)).json();
      await page.getByLabel('这个线程的更多操作').click();
      await page.getByRole('menuitem',{name:'交接',exact:true}).click();
      const dialog = page.getByRole('dialog',{name:'交接',exact:true});
      await dialog.locator('.handover-summary').waitFor();
      const summary = await dialog.locator('.handover-summary').innerText();
      for (const value of ['Claude 工作号','实例 ID：claude-work',daemon.workdir,configDir,'Session ID：work-session','work-session.jsonl','CLAUDE_CONFIG_DIR=','修复登录页并补测试']) assert.ok(summary.includes(value),value);
      assert.equal(await dialog.getByRole('radiogroup').count(),0,'no successor needed even with one available agent');
      assert.deepEqual(await (await api(daemon,`/api/threads/${thread.id}/events`)).json(),before,'opening spends no turn');
      await dialog.getByRole('button',{name:'复制交接信息'}).click();
      await dialog.getByRole('button',{name:'已复制'}).waitFor();
      assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),summary);
      const box=await dialog.boundingBox();
      const vp=page.viewportSize();
      assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=vp.width+1&&box.y+box.height<=vp.height+1);
      if (process.env.RAH_SCREENSHOTS === '1') {
        const shots=join(repoRoot,'e2e','shots');
        mkdirSync(shots,{recursive:true});
        await page.screenshot({path:join(shots,`handover-${mobile?'phone':'desktop'}-${theme}.png`),animations:'disabled'});
      }
      await page.keyboard.press('Escape');
      await dialog.waitFor({state:'detached'});
    } finally { await context.close(); }
  });
}
