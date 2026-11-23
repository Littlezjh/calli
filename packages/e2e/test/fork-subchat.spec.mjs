import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startDaemon, openUi, api, launchBrowser } from '../harness.mjs';

let daemon;
let browser;
let page;

before(async () => {
  daemon = await startDaemon();
  browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  page = await ctx.newPage();
});

after(async () => {
  await browser?.close();
  await daemon?.stop();
});

test('fork as sub-conversation groups under the lead in sidebar with purpose tag, and coexists with handover chain', async () => {
  // Seed a root thread + one turn via API so the test stays deterministic and fast.
  const root = await (await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: daemon.workdir, title: '主线重构' }) })).json();
  await api(daemon, `/api/threads/${root.id}/turns`, { method: 'POST', body: JSON.stringify({ text: '主线第一轮' }) });
  for (let i = 0; i < 200; i++) {
    const t = await (await api(daemon, `/api/threads/${root.id}`)).json();
    if (t.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 25));
  }

  await openUi(page, daemon);
  await page.locator('.sidebar-inner').getByText('主线重构').first().click();
  await page.getByText('hi there 主线第一轮').waitFor({ timeout: 10_000 });

  // Open page menu -> 分叉与交接 -> 分叉为子对话
  await page.locator('.topbar-more').click();
  await page.getByRole('menuitem', { name: '分叉与交接' }).click();
  await page.getByRole('menuitem', { name: '分叉为子对话' }).click();
  await page.locator('.fork-subchat-dialog').waitFor();

  // Fill purpose tag only -> button reads "分叉并进入" -> opens new sub-conversation
  await page.locator('.fork-subchat-dialog input[type="text"]').fill('分析 one page');
  const confirmBtn = page.locator('.fork-subchat-dialog button', { hasText: '分叉并进入' });
  await confirmBtn.click();
  await page.locator('.fork-subchat-dialog').waitFor({ state: 'detached', timeout: 10_000 });

  // Sidebar now folds the sub-conversation under root with the purpose tag pill.
  await page.locator('.sidebar-inner .fork-tag-pill', { hasText: '分析 one page' }).waitFor({ timeout: 10_000 });
  // Chat on a different topic inside the sub-conversation.
  await page.locator('.composer textarea').click();
  await page.keyboard.type('子话题讨论');
  await page.keyboard.press('Enter');
  await page.locator('.markdown').filter({ hasText: '子话题讨论' }).last().waitFor({ timeout: 10_000 });
  await page.locator('.markdown').filter({ hasText: '主线重构' }).last().waitFor({ timeout: 5_000 });

  // Verify phone dark & light viewports have no horizontal overflow and capture screenshots if requested.
  const shotDir = process.env.CALLI_FORK_SHOTS;
  if (shotDir) {
    await page.screenshot({ path: `${shotDir}/desktop-light.png` });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.screenshot({ path: `${shotDir}/desktop-dark.png` });
  }
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pPage = await phoneCtx.newPage();
  await openUi(pPage, daemon);
  await pPage.locator('.topbar button').first().click();
  await pPage.locator('.sidebar-inner .handover-toggle').first().click();
  await pPage.locator('.sidebar-inner .fork-tag-pill', { hasText: '分析 one page' }).waitFor({ timeout: 5_000 });
  const overflow = await pPage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, 'no horizontal overflow on phone');
  if (shotDir) {
    await pPage.screenshot({ path: `${shotDir}/phone-light.png` });
    await pPage.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await pPage.screenshot({ path: `${shotDir}/phone-dark.png` });
  }
  await phoneCtx.close();
});
