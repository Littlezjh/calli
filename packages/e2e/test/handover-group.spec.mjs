import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { startDaemon, openUi, api, launchBrowser } from '../harness.mjs';

test('handover groups and bidirectional navigation on desktop and phone in both themes', async () => {
  const hub = await startDaemon();
  let browser;
  try {
    const post = async (path, body) => {
      const res = await api(hub, path, { method: 'POST', body: JSON.stringify(body) });
      assert.equal(res.status, 201);
      return res.json();
    };
    const original = await post('/api/threads', { agent: 'pi', cwd: hub.workdir, title: '增加技能管理功能' });
    const next = await post(`/api/threads/${original.id}/handover-thread`, { agent: 'claude' });
    browser = await launchBrowser();
    mkdirSync('/tmp/rah-handover-shots', { recursive: true });
    for (const phone of [false, true]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 960 }, isMobile: phone, hasTouch: phone, colorScheme: theme });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript((token) => localStorage.setItem('rah.token', token), hub.token);
      await openUi(page, hub);
      if (phone) await page.getByRole('button', { name: '打开线程列表', exact: true }).click();
      await page.locator('.handover-group').waitFor();
      assert.equal(await page.locator('.handover-group').count(), 1);
      assert.equal(await page.locator('.handover-group .thread-item').count(), 1);
      await page.locator('.handover-toggle').click();
      assert.equal(await page.locator('.handover-members .thread-item').count(), 2);
      await page.waitForTimeout(250);
      await page.screenshot({ path: `/tmp/rah-handover-shots/${phone ? 'phone' : 'desktop'}-${theme}-sidebar.png` });
      await page.locator('.handover-head .thread-item').click();
      await page.getByRole('button', { name: '接手自 pi · 交接记录', exact: true }).waitFor();
      await page.locator('.handover-link').click();
      await page.getByRole('menu', { name: '交接记录' }).waitFor();
      await page.waitForTimeout(250);
      await page.screenshot({ path: `/tmp/rah-handover-shots/${phone ? 'phone' : 'desktop'}-${theme}-trail.png` });
      await page.locator('.handover-entry').filter({ hasText: '原始会话' }).click();
      await page.getByRole('button', { name: /已交接给.*交接记录/ }).waitFor();
      await page.locator('.handover-link').click();
      await page.locator('.handover-entry').filter({ hasText: '接手会话' }).click();
      await page.getByRole('button', { name: '接手自 pi · 交接记录', exact: true }).waitFor();
      assert.deepEqual(errors, []);
      assert.ok(next.handover.sourceId === original.id);
      await context.close();
    }
  } finally {
    await browser?.close();
    await hub.stop();
  }
});
