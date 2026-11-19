import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { startDaemon, launchBrowser, openUi, api } from '../harness.mjs';

let daemon, browser;
before(async () => { daemon = await startDaemon(); browser = await launchBrowser(); });
after(async () => { await browser?.close(); await daemon?.stop(); });
const post = async (path, body) => {
  const response = await api(daemon, path, { method: 'POST', body: JSON.stringify(body) });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
};

for (const phone of [false, true]) for (const colorScheme of ['light', 'dark']) {
  test(`collaborators stay visible and open their panel: ${phone ? 'phone' : 'desktop'} ${colorScheme}`, { timeout: 60000 }, async () => {
    const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: phone, hasTouch: phone, colorScheme });
    try {
      const root = await post('/api/threads', { agent: 'pi', cwd: daemon.workdir, title: `协作入口 ${phone} ${colorScheme}` });
      const plain = await post('/api/threads', { agent: 'pi', cwd: daemon.workdir, title: `普通会话 ${phone} ${colorScheme}` });
      await post(`/api/threads/${root.id}/coordination`, {});
      // 通过真实注入 CLI 建立成员；慢任务让运行状态保持到用户打开面板。
      const directive = Buffer.from(JSON.stringify({ args: ['spawn', '--agent', 'pi', '--name', 'Codex_review', '--message-file', '-', '--request-id', 'visible-member'], text: 'slow' })).toString('base64');
      await post(`/api/threads/${root.id}/turns`, { text: `CALLI_COMMAND:${directive}` });
      const page = await context.newPage();
      await openUi(page, daemon);
      if (phone) await page.locator('.menu-btn').click();
      await page.locator('.thread-row', { hasText: root.title }).click();
      if (phone) await page.waitForFunction(() => document.querySelector('.main')?.getBoundingClientRect().left <= 1);
      const bar = page.locator('.coord-bar');
      await bar.getByText('Codex_review', { exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelector('.coord-status-note')?.textContent.includes('1 运行中'));
      assert.match(await bar.innerText(), /1 个/);
      assert.ok(await bar.locator('button').evaluate(el => el.scrollWidth <= el.clientWidth), 'the collaborator line fits the composer');
      const box = page.getByRole('textbox', { name: '消息', exact: true });
      await box.fill('保留主会话草稿');
      const shots = '/tmp/calli-collaboration-visibility'; mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: `${shots}/${phone ? 'phone' : 'desktop'}-${colorScheme}.png` });
      await bar.getByRole('button', { name: '查看智能体', exact: true }).click();
      const panel = page.getByRole('region', { name: '智能体面板' });
      await panel.locator('.agent-member', { hasText: 'Codex_review' }).waitFor();
      await panel.getByRole('button', { name: '关闭智能体面板', exact: true }).click();
      await panel.waitFor({ state: 'detached' });
      assert.equal(await box.inputValue(), '保留主会话草稿');
      await post(`/api/threads/${root.id}/coordination`, { action: 'stop' });
      await page.waitForFunction(() => document.querySelector('.coord-status-note')?.textContent.includes('已暂停'));
      // 切到普通会话后不能残留上一个团队的成员或状态。
      if (phone) await page.locator('.menu-btn').click();
      await page.locator('.thread-row', { hasText: plain.title }).click();
      await bar.waitFor({ state: 'detached' });
    } finally { await context.close(); }
  });
}
