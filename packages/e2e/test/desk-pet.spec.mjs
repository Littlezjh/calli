import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { launchBrowser } from '../harness.mjs';

test('a pet reply naming a child opens its parent pile, and an unconfigured delegate opens settings', { timeout: 30_000 }, async () => {
  // Check the Desk/Pet contract independently of the Router transport and sprite installation.
  const bundle = await build({
    stdin: { contents: `
      import { createRoot } from 'react-dom/client';
      import { DeskPage } from './components/DeskPage';
      const createdAt = new Date().toISOString();
      const base = { done:false, position:0, createdAt, doneAt:null, threads:[] };
      const todos = [
        { ...base, id:'parent', text:'Review experiment', parentId:null, lane:'later' },
        { ...base, id:'child', text:'Check control group', parentId:'parent' },
      ];
      const api = {
        pet: async () => ({installed:true, installing:false, error:null, id:'dafeiyu', clips:{idle:1}, frameMs:84}),
        petFrame: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        petRouter: async () => ({threadId:'router', status:'idle', lastReply:'Next: Check control group', lastReplyAt:createdAt}),
        todoNote: async () => ({text:'',updatedAt:null,threadId:null,rev:0}),
        workdirs: async () => ({workdirs:[]}),
      };
      localStorage.setItem('calli.pet.pending', JSON.stringify({since:null,threadId:'router',sentAt:Date.now(),text:'What next?'}));
      createRoot(document.getElementById('root')).render(<DeskPage api={api} todos={todos} loading={false} error="" threads={[]} agents={[]} personal={{agent:null,model:null,directory:null}} personalError="" refreshKey={0} onReload={() => {}} onPersonalChange={() => {}} onPersonalRetry={() => {}} onPetStatusChange={() => {}} onOpenThread={() => {}} onOpenPlans={() => {}} />);
    `, loader:'tsx', resolveDir:fileURLToPath(new URL('../../web/src/', import.meta.url)) },
    bundle:true, write:false, format:'iife', platform:'browser', jsx:'automatic',
  });
  const css = readFileSync(new URL('../../web/src/styles.css', import.meta.url), 'utf8');
  const server = createServer((_req, res) => res.end('<!doctype html><div id="root"></div>'));
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await launchBrowser();
    const page = await browser.newPage({ reducedMotion:'reduce', locale:'zh-CN' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.addStyleTag({ content:css });
    await page.addScriptTag({ content:bundle.outputFiles[0].text });
    await page.locator('.desk-week.quiet').waitFor();
    assert.ok((await page.locator('.desk-week').boundingBox()).height < 120, 'zero completions use a compact, explicit empty week');
    assert.equal(await page.locator('.desk-week .desk-chart-day').count(), 7);
    await page.locator('.pet-say-todo', { hasText:'Check control group' }).click();
    await page.locator('#desk-spread-title', { hasText:'Review experiment' }).waitFor();
    assert.equal(await page.locator('.pet-say').count(), 0, 'opening the matter clears the reply bubble');
    await page.getByRole('checkbox', { name:'Check control group' }).waitFor();
    await page.locator('.pet-body').click();
    await page.locator('.pet-field').waitFor();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('.pet-card'))), true, 'the spread does not take keyboard focus from another dialog');
    await page.locator('.pet-field').focus();
    await page.keyboard.press('Escape');
    await page.locator('.pet-card').waitFor({ state:'detached' });
    assert.equal(await page.locator('.desk-spread').count(), 1);
    const delegate = page.getByRole('button', { name:'交给 agent', exact:true });
    assert.equal(await delegate.isEnabled(), true);
    assert.equal(await delegate.getAttribute('title'), '先在私人设置里选 agent');
    await delegate.click();
    await page.locator('.personal-settings').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.personal-settings').waitFor({ state:'detached' });
    assert.equal(await page.locator('.desk-spread').count(), 1);
    await page.keyboard.press('Escape');
    await page.locator('.desk-spread').waitFor({ state:'detached' });
    await page.waitForFunction(() => document.activeElement.id === 'desk-stack-later');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
