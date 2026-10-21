import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon, openUi, api, launchBrowser, repoRoot } from '../harness.mjs';

let hub, browser, dir;
const shots = join(repoRoot, 'e2e', 'shots', 'handover-mode');
const request = async (path, method = 'GET', body) => {
  const response = await api(hub, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
};
const wait = async check => {
  for (let i = 0; i < 200; i++) { const result = await check(); if (result) return result; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('condition timed out');
};
const idle = id => wait(async () => (await request(`/api/threads/${id}`)).status === 'idle');
const send = (id, text) => request(`/api/threads/${id}/turns`, 'POST', { text });
const create = title => request('/api/threads', 'POST', { agent: 'first', cwd: hub.workdir, title });
const sidebar = async (page, mobile) => {
  if (mobile && !await page.locator('.app.drawer-open').count()) await page.locator('.menu-btn').click();
};
const select = async (page, title, mobile) => {
  await sidebar(page, mobile);
  await page.locator('.sidebar .thread-item').filter({ has: page.locator('.thread-title', { hasText: new RegExp(`^${title}$`) }) }).click();
  if (mobile) await page.waitForFunction(() => getComputedStyle(document.querySelector('.sidebar')).visibility === 'hidden', null, { timeout: 5000 });
};
const dialog = async page => {
  await page.getByLabel('这个线程的更多操作').click();
  await page.getByRole('menuitem', { name: '交接', exact: true }).click();
  const value = page.getByRole('dialog', { name: '交接', exact: true });
  await value.locator('.handover-summary').waitFor(); return value;
};
const handover = async (page, modal) => {
  const [response] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/handover-thread') && r.request().method() === 'POST'), modal.getByRole('button', { name: '新建接手对话', exact: true }).click()]);
  assert.equal(response.status(), 201);
  const next = await response.json(); await modal.waitFor({ state: 'detached' });
  await page.locator('.topbar-title').filter({ hasText: next.title }).waitFor(); return next;
};
const uiSend = async (page, id, text) => {
  await page.locator('.composer textarea').fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await wait(async () => (await request(`/api/threads/${id}/events`)).some(e => e.type === 'turn.started' && e.data.text === text));
  await idle(id);
};
const origin = async page => {
  await page.locator('.handover-trail button').click();
  await page.getByRole('menuitem').filter({ hasText: '原始会话' }).click();
};
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rah-mode-e2e-')); mkdirSync(shots, { recursive: true });
  hub = await startDaemon({ RAH_AGENTS_JSON: JSON.stringify({ agents: ['first', 'next'].map((id, i) => ({ id, adapter: 'claude', label: `Agent ${i + 1}`, command: ['fake-claude'], env: { CLAUDE_CONFIG_DIR: join(dir, id), FAKE_SESSION_ROOT: join(dir, id) } })) }) });
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); await hub?.stop(); rmSync(dir, { recursive: true, force: true }); });

for (const mobile of [false, true]) for (const theme of ['light', 'dark']) {
  test(`branch and continue preserve composer ownership: ${mobile ? 'phone' : 'desktop'} ${theme}`, async () => {
    const name = `${mobile ? 'phone' : 'desktop'}-${theme}`;
    const source = await create(`并行任务 ${name}`); await send(source.id, 'slow original task');
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 }, isMobile: mobile, hasTouch: mobile, colorScheme: theme });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    try {
      await openUi(page, hub); await select(page, source.title, mobile);
      const modal = await dialog(page);
      assert.equal(await modal.locator('.handover-mode-choice button').innerText(), '新开会话');
      await page.screenshot({ path: join(shots, `running-dialog-${name}.png`), animations: 'disabled' });
      const branch = await handover(page, modal);
      assert.equal(branch.handover.mode, 'branch');
      assert.equal((await request(`/api/threads/${source.id}`)).status, 'running');
      assert.equal(await page.locator('.handover-readonly, .merged-history').count(), 0);
      await sidebar(page, mobile);
      for (const title of [source.title, branch.title]) assert.equal(await page.locator('.sidebar .thread-title').filter({ hasText: new RegExp(`^${title}$`) }).count(), 1);
      assert.equal(await page.locator('.sidebar .thread-item').filter({ hasText: branch.title }).locator('.thread-fork').count(), 1);
      await page.screenshot({ path: join(shots, `branch-sidebar-${name}.png`), animations: 'disabled' });
      await select(page, branch.title, mobile);
      await uiSend(page, branch.id, '独立处理新任务');
      await request(`/api/threads/${source.id}/cancel`, 'POST'); await idle(source.id);
      await origin(page);
      assert.equal(await page.locator('.handover-readonly, .merged-history').count(), 0);
      await uiSend(page, source.id, '原会话继续工作');
      assert.ok(!(await request(`/api/threads/${branch.id}/events`)).some(e => e.type === 'turn.started' && e.data.text === '原会话继续工作'));
      await page.locator('.handover-trail button').click();
      await page.getByRole('menuitem').filter({ hasText: '接手会话' }).click();
      await uiSend(page, branch.id, '新会话再次独立工作');
      await page.locator('.handover-trail button').click();
      await page.getByRole('menuitem').filter({ hasText: '分出去' }).waitFor();
      assert.equal(await page.locator('.handover-mode').count(), 0);
      await page.screenshot({ path: join(shots, `branch-history-${name}.png`), animations: 'disabled' });
      await page.keyboard.press('Escape');

      const relay = await create(`接力任务 ${name}`); await send(relay.id, '准备交接的任务'); await idle(relay.id);
      await select(page, relay.title, mobile);
      const stopped = await dialog(page);
      assert.equal(await stopped.locator('.handover-mode-choice button').innerText(), '接力');
      await stopped.locator('.handover-mode-choice button').click();
      await page.getByRole('menuitemradio', { name: '新开会话', exact: true }).waitFor();
      await page.getByRole('menuitemradio', { name: '接力', exact: true }).click();
      const continued = await handover(page, stopped);
      assert.equal(continued.handover.mode, 'continue');
      await page.locator('.merged-history').waitFor();
      await uiSend(page, continued.id, '接手继续处理');
      await origin(page);
      await page.locator('.handover-readonly').waitFor();
      await uiSend(page, continued.id, '从前段输入也发给接手方');
      await origin(page);
      await page.locator('.handover-readonly').waitFor();
      await page.screenshot({ path: join(shots, `continue-source-${name}.png`), animations: 'disabled' });
      // External/source-side activity changes only this relation; the open page responds live.
      await send(relay.id, '原会话重新开启一轮'); await idle(relay.id);
      await wait(async () => (await request(`/api/threads/${continued.id}`)).handover.mode === 'branch');
      await page.locator('.handover-readonly').waitFor({ state: 'detached' });
      await page.locator('.merged-history').waitFor({ state: 'detached' });
      await uiSend(page, relay.id, '解除接力后发回当前会话');
      assert.ok(!(await request(`/api/threads/${continued.id}/events`)).some(e => e.type === 'turn.started' && e.data.text === '解除接力后发回当前会话'));
      await page.screenshot({ path: join(shots, `resumed-source-${name}.png`), animations: 'disabled' });
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test('explicit continue stops a running source before creating its replacement', async () => {
  const source = await create('停止原轮后接力'); await send(source.id, 'slow original turn');
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  try {
    await openUi(page, hub); await select(page, source.title, false);
    const modal = await dialog(page);
    await modal.locator('.handover-mode-choice button').click();
    await page.getByRole('menuitemradio', { name: '停下原会话，接着做', exact: true }).click();
    const next = await handover(page, modal);
    assert.equal(next.handover.mode, 'continue');
    assert.equal((await request(`/api/threads/${source.id}`)).status, 'idle');
    assert.ok((await request(`/api/threads/${source.id}/events`)).some(e => e.type === 'turn.done' && e.data.stopReason === 'cancelled'));
    await page.locator('.merged-history').waitFor();
  } finally { await context.close(); }
});
