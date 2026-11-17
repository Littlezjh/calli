import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { startDaemon, openUi, api, launchBrowser, repoRoot } from '../harness.mjs';

// A handover made by hand is cancelled from the thread's own menu: the link goes, both
// conversations stay, and the successor stays on screen as a conversation of its own.
const out = process.env.CALLI_SHOTS ?? join(repoRoot, 'e2e', 'shots', 'handover-cancel');
let daemon, browser;
before(async () => { daemon = await startDaemon(); browser = await launchBrowser(); mkdirSync(out, { recursive: true }); });
after(async () => { await browser?.close(); await daemon?.stop(); });

const json = async (path, method = 'GET', body) => {
  const res = await api(daemon, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(res.ok, `${path} answered ${res.status}`);
  return res.json();
};

for (const mobile of [false, true]) for (const theme of ['light', 'dark']) {
  test(`a manual handover is cancelled from its menu: ${mobile ? 'phone' : 'desktop'} ${theme}`, async () => {
    const title = `周报统计 ${mobile ? 'p' : 'd'}${theme}`;
    const source = await json('/api/threads', 'POST', { agent: 'claude', cwd: daemon.workdir, title });
    await json(`/api/threads/${source.id}/turns`, 'POST', { text: '修复登录页' });
    const successor = await json(`/api/threads/${source.id}/handover-thread`, 'POST', { agent: 'claude', mode: 'branch' });
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 }, isMobile: mobile, hasTouch: mobile, colorScheme: theme });
    const page = await context.newPage();
    try {
      await openUi(page, daemon);
      // The sidebar folds a handover chain into one card; the link opens the successor directly.
      await page.evaluate((id) => { location.hash = `#/thread/${id}`; }, successor.id);
      await page.locator('.topbar-title', { hasText: successor.title }).waitFor();
      await page.getByLabel('这个线程的更多操作').click();
      const item = page.getByRole('menuitem', { name: '取消交接', exact: true });
      await item.waitFor();
      await page.screenshot({ path: join(out, `menu-${mobile ? 'phone' : 'desktop'}-${theme}.png`) });
      await item.click();
      for (const end = Date.now() + 10_000; !(await json(`/api/threads/${successor.id}`)).handover?.detached;) {
        assert.ok(Date.now() < end, 'the successor is unlinked'); await page.waitForTimeout(100);
      }
      assert.equal((await json(`/api/threads/${successor.id}`)).archivedAt, null, 'the successor stays');
      assert.equal((await json(`/api/threads/${source.id}`)).archivedAt, null, 'the source stays');
      await page.locator('.topbar-title', { hasText: successor.title }).waitFor({ timeout: 5000 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(out, `after-${mobile ? 'phone' : 'desktop'}-${theme}.png`) });
      // Unlinked, it offers no cancel any more.
      await page.getByLabel('这个线程的更多操作').click();
      await page.getByRole('menuitem', { name: '归档', exact: true }).first().waitFor();
      assert.equal(await page.getByRole('menuitem', { name: '取消交接', exact: true }).count(), 0);
    } finally { await context.close(); }
  });
}
