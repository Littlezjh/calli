import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, openUi, api, launchBrowser, repoRoot } from '../harness.mjs';

test('hidden accounts disappear from quota and are not queried; restoring brings them back', { timeout: 120_000 }, async () => {
  const command = [process.execPath, join(repoRoot, 'daemon/test/fixtures/fake-codex.mjs')];
  const daemon = await startDaemon({ CALLI_AGENTS_JSON: JSON.stringify({ agents: [
    { id: 'primary', adapter: 'codex', label: 'Primary', command },
    { id: 'backup', adapter: 'codex', label: 'Backup', command },
  ] }) });
  let browser;
  try {
    browser = await launchBrowser();
    for (const phone of [false, true]) for (const theme of ['light', 'dark']) {
      for (const id of ['primary', 'backup']) assert.equal((await api(daemon, `/api/agents/${id}`, { method: 'PATCH', body: JSON.stringify({ hidden: false }) })).status, 200);
      const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 960 }, isMobile: phone, hasTouch: phone, colorScheme: theme });
      try {
        const page = await context.newPage();
        const requests = [];
        page.on('request', request => { if (/\/api\/agents\/[^/]+\/quota/.test(request.url())) requests.push(new URL(request.url()).pathname); });
        await openUi(page, daemon);
        const toggle = async (name, hidden) => {
          await page.evaluate(() => { location.hash = '#/agents'; });
          const row = page.locator('.agents-row').filter({ has: page.getByText(name, { exact: true }) });
          await row.getByRole('button', { name: '操作', exact: true }).click();
          await page.getByRole('menuitem', { name: hidden ? '从新会话隐藏' : '恢复到新会话', exact: true }).click();
          await row.locator('.agents-hidden').waitFor({ state: hidden ? 'visible' : 'detached' });
        };
        const settings = async () => {
          if (phone) await page.locator('.menu-btn').click();
          await page.getByRole('button', { name: '配置', exact: true }).click();
        };
        const openBoard = async () => { await settings(); await page.getByRole('menuitem', { name: '额度', exact: true }).click(); };
        const board = page.getByRole('dialog', { name: '额度看板', exact: true });
        await toggle('Primary', true);
        await openBoard();
        await board.locator('.quota-percent').first().waitFor();
        assert.deepEqual(await board.locator('.quota-board-name').allTextContents(), ['Backup']);
        assert.equal(requests.includes('/api/agents/primary/quota'), false);
        const refresh = page.waitForResponse(response => response.url().includes('/api/agents/backup/quota?refresh=1'));
        await board.getByRole('button', { name: '全部刷新', exact: true }).click();
        await refresh;
        assert.equal(requests.includes('/api/agents/primary/quota'), false, 'refresh all does not query hidden accounts');
        if (process.env.CALLI_E2E_SHOTS_DIR) {
          mkdirSync(process.env.CALLI_E2E_SHOTS_DIR, { recursive: true });
          await page.screenshot({ path: join(process.env.CALLI_E2E_SHOTS_DIR, `quota-hidden-${phone ? 'phone' : 'desktop'}-${theme}.png`), animations: 'disabled' });
        }
        await board.getByRole('button', { name: '关闭', exact: true }).click();
        await toggle('Primary', false);
        await openBoard();
        await board.locator('.quota-board-row').filter({ hasText: 'Primary' }).locator('.quota-percent').first().waitFor();
        assert.deepEqual((await board.locator('.quota-board-name').allTextContents()).sort(), ['Backup', 'Primary']);
        assert.equal(requests.includes('/api/agents/primary/quota'), true);
        await board.getByRole('button', { name: '关闭', exact: true }).click();
        await toggle('Primary', true);
        await toggle('Backup', true);
        await settings();
        assert.equal(await page.getByRole('menuitem', { name: '额度', exact: true }).count(), 0, 'the entry hides when every quota account is hidden');
      } finally { await context.close(); }
    }
  } finally { await browser?.close(); await daemon.stop(); }
});
