import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, openUi, api, launchBrowser } from '../harness.mjs';

let daemon, browser;
const shots = process.env.CALLI_E2E_SHOTS_DIR;
before(async () => {
  daemon = await startDaemon({ CALLI_AGENTS_JSON: JSON.stringify({ agents: [{ id: 'doubao', adapter: 'doubao', command: ['fake-doubao'] }] }) });
  browser = await launchBrowser();
  if (shots) mkdirSync(shots, { recursive: true });
});
after(async () => { await browser?.close(); await daemon?.stop(); });

const waitIdle = async id => {
  for (let index = 0; index < 150; index++) {
    const view = await (await api(daemon, `/api/threads/${id}`)).json();
    if (view.status !== 'running') return view;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail('Doubao turn did not finish');
};
const send = async (page, text) => {
  await page.locator('.composer textarea').fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
};

for (const mobile of [false, true]) for (const colorScheme of ['light', 'dark']) {
  const mode = `${mobile ? 'phone' : 'desktop'}-${colorScheme}`;
  test(`Doubao public CLI lifecycle in ${mode}`, { timeout: 60_000 }, async () => {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, colorScheme });
    try {
      await context.addInitScript(() => localStorage.setItem('calli_onboard_dismissed', '1'));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      const shot = async name => { if (shots) await page.screenshot({ path: join(shots, `doubao-${mode}-${name}.png`), animations: 'disabled' }); };
      await openUi(page, daemon);
      await page.locator('.composer .context-btn').first().click();
      const agent = page.getByRole('menuitemradio', { name: 'Doubao CLI', exact: true });
      await agent.waitFor();
      assert.equal(await agent.locator('.pop-item-icon svg').count(), 1, 'the native mark is supplied by the adapter');
      await shot('picker');
      await agent.click();
      assert.equal(await page.locator('.composer .model-control-trigger').count(), 0, 'no invented model or effort catalog');
      await page.getByRole('button', { name: '添加与模式', exact: true }).click();
      const plan = page.getByRole(mobile ? 'menuitemcheckbox' : 'option', { name: /^计划模式/ });
      assert.equal(await plan.count(), 0, 'no native plan mode');
      await page.keyboard.press('Escape');
      await page.locator('.composer textarea').click();
      const hello = `接入检查 ${mode}`;
      await send(page, hello);
      await page.getByText(`doubao:${hello}`, { exact: true }).waitFor({ timeout: 15_000 });
      await page.getByRole('button', { name: '停止', exact: true }).waitFor({ state: 'hidden' });
      const threads = await (await api(daemon, '/api/threads')).json();
      const thread = threads.find(value => value.title === hello);
      assert.ok(thread.agentSessionId, 'the lazy native identity reaches the thread and browser');
      assert.equal(thread.permissionMode, 'auto_edit');
      assert.equal(thread.agent, 'doubao');
      const sessionId = thread.agentSessionId;
      await shot('reply');
      await page.reload();
      await page.locator('.sidebar-inner').waitFor({ state: 'attached' });
      if (mobile) await page.locator('.menu-btn').click();
      await page.locator('.thread-title', { hasText: hello }).first().click();
      await page.getByText(`doubao:${hello}`, { exact: true }).waitFor();
      await send(page, `继续检查 ${mode}`);
      await page.getByText(`doubao:继续检查 ${mode}`, { exact: true }).waitFor();
      assert.equal((await waitIdle(thread.id)).agentSessionId, sessionId);

      const permission = page.locator('.composer .tool-btn.keep').first();
      await permission.click();
      assert.equal(await page.getByRole('menuitemradio', { name: /^请求批准/ }).count(), 0, 'headless tasks cannot ask for approval');
      await page.getByRole('menuitemradio', { name: /^完全访问权限/ }).click();
      await send(page, 'slow');
      await page.getByText('working', { exact: true }).waitFor();
      await shot('running');
      await page.getByRole('button', { name: '停止', exact: true }).click();
      await page.getByRole('button', { name: '停止', exact: true }).waitFor({ state: 'hidden' });
      assert.equal((await waitIdle(thread.id)).agentSessionId, sessionId);
      const stopped = await (await api(daemon, `/api/threads/${thread.id}/events`)).json();
      assert.equal(stopped.filter(event => event.type === 'turn.done').at(-1).data.stopReason, 'cancelled');
      await send(page, `停止后继续 ${mode}`);
      await page.getByText(`doubao:停止后继续 ${mode}`, { exact: true }).waitFor();
      await page.getByRole('button', { name: '停止', exact: true }).waitFor({ state: 'hidden' });
      assert.equal((await waitIdle(thread.id)).agentSessionId, sessionId);
      await shot('resumed');
      assert.equal(await page.locator('.composer .model-control-trigger').count(), 0);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal page overflow');
      await page.evaluate(() => { location.hash = '#/agents'; });
      await page.locator('.agents-page').waitFor();
      const row = page.locator('.agents-row').filter({ hasText: 'Doubao CLI' });
      await row.getByRole('button', { name: '登录', exact: true }).waitFor();
      await shot('management');
      await page.evaluate(() => { location.hash = '#/observability'; });
      await page.getByRole('button', { name: 'Agent 诊断', exact: true }).click();
      await page.locator('.obs-diagnostic').getByText('CLI 可启动', { exact: true }).waitFor();
      await page.locator('.obs-diagnostic').getByText(/原生接口不提供模型目录/).waitFor();
      await shot('diagnostics');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}
