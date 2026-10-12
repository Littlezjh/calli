import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { buildOnce, startDaemon, openUi, api, launchBrowser } from '../harness.mjs';

let daemon, browser;
before(async () => { await buildOnce(); daemon = await startDaemon(); browser = await launchBrowser(); });
after(async () => { await browser?.close(); await daemon?.stop(); });
const post = async (path, body) => {
  const response = await api(daemon, path, { method: 'POST', body: JSON.stringify(body) });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
};
const waitIdle = async id => {
  for (let n = 0; n < 200; n++) {
    const thread = await (await api(daemon, `/api/threads/${id}`)).json();
    if (thread.status !== 'running') return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('thread did not finish');
};

for (const phone of [false, true]) for (const colorScheme of ['light', 'dark']) {
  test(`collaboration picker, output and draft preservation: ${phone ? 'phone' : 'desktop'} ${colorScheme}`, async () => {
    const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: phone, hasTouch: phone, colorScheme });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    try {
      const title = `文档协作 ${phone ? '手机' : '桌面'} ${colorScheme}`;
      const root = await post('/api/threads', { agent: 'pi', cwd: daemon.workdir, title });
      await openUi(page, daemon);
      if (phone) await page.locator('.menu-btn').click();
      await page.locator('.thread-row', { hasText: title }).click();
      await page.getByRole('button', { name: '协作', exact: true }).click();
      await page.getByRole('button', { name: '启用协作', exact: true }).click();
      await page.getByRole('button', { name: '查看智能体', exact: true }).waitFor();
      const box = page.locator('.composer textarea');
      await box.fill('@');
      await page.getByRole('option', { name: /claude/i }).first().click();
      assert.match(await page.locator('.coord-mentions').innerText(), /claude/i);
      await box.fill('请审查接口文档');
      const sent = page.waitForRequest(req => req.url().endsWith(`/threads/${root.id}/turns`) && req.method() === 'POST');
      await page.getByRole('button', { name: '发送', exact: true }).click();
      assert.equal((await sent).postDataJSON().mentions[0].id, 'claude');
      await waitIdle(root.id);
      await page.waitForFunction(() => document.querySelector('.composer textarea')?.value === '');

      // The fixture invokes the actual injected CLI, creating a normal member thread.
      const directive = Buffer.from(JSON.stringify({ args: ['spawn', '--agent', 'claude', '--name', '文档审查', '--message-file', '-', '--request-id', 'review'], text: '检查接口与异常处理 LIMI_REPORT' })).toString('base64');
      await post(`/api/threads/${root.id}/turns`, { text: `LIMI_COMMAND:${directive}` });
      await box.fill('保留这段主线程草稿');
      await page.getByRole('button', { name: '查看智能体', exact: true }).click();
      const panel = page.getByRole('region', { name: '智能体面板' });
      const card = panel.locator('.agent-member', { hasText: '文档审查' });
      await card.waitFor();
      await page.waitForFunction(() => document.querySelector('.agent-member')?.textContent?.includes('已返回'));
      const team = await (await api(daemon, `/api/threads/${root.id}/coordination`)).json();
      const child = team.members[0].id;
      const before = await (await api(daemon, `/api/threads/${child}/events`)).json();
      // The detail retries even if its first history request fails.
      await page.route(`**/threads/${child}/events?tail=1`, route => route.fulfill({ status: 503, body: '{"error":"offline"}' }), { times: 1 });
      await card.click();
      await panel.getByText('文档审查完成。', { exact: false }).waitFor();
      assert.equal(await panel.locator('textarea').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), colorScheme);
      if (phone) {
        const rect = await panel.boundingBox();
        assert.ok(rect && rect.x === 0 && Math.abs(rect.width - 390) < 2);
      }
      const shots = '/tmp/limi-coordination-shots'; mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: `${shots}/${phone ? 'phone' : 'desktop'}-${colorScheme}-detail.png` });
      await panel.getByRole('button', { name: '返回智能体列表' }).click();
      await card.waitFor();
      await panel.locator('.coord-unread').waitFor({ state: 'detached' });
      await page.screenshot({ path: `${shots}/${phone ? 'phone' : 'desktop'}-${colorScheme}-list.png` });
      await panel.getByRole('button', { name: '关闭智能体面板' }).click();
      await panel.waitFor({ state: 'detached' });
      assert.equal(await box.inputValue(), '保留这段主线程草稿');
      const after = await (await api(daemon, `/api/threads/${child}/events`)).json();
      assert.equal(after.filter(e => e.type === 'turn.started').length, before.filter(e => e.type === 'turn.started').length, 'viewing output does not start work');
      await page.getByRole('button', { name: '查看智能体', exact: true }).click();
      await card.click();
      if (phone) {
        await page.goBack();
        await card.waitFor();
        await page.goBack();
        await panel.waitFor({ state: 'detached' });
      } else {
        await page.keyboard.press('Escape');
        await panel.waitFor({ state: 'detached' });
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}
