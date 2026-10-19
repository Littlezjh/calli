import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, openUi, api, launchBrowser, repoRoot } from '../harness.mjs';

let daemon;
let browser;
before(async () => {
  daemon = await startDaemon({ RAH_AGENTS_JSON: JSON.stringify({ agents: ['claude', 'codex'].map((id) => ({
    id, adapter: id, command: [process.execPath, join(repoRoot, 'daemon/test/fixtures', `fake-${id === 'claude' ? 'acp' : id}.mjs`)],
  })) }) });
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); await daemon?.stop(); });

test('Codex quota, commands and skills work on desktop and phone in both themes', async () => {
  for (const mobile of [false, true]) {
    for (const colorScheme of ['light', 'dark']) {
      const title = `命令测试 ${mobile ? '手机' : '桌面'} ${colorScheme}`;
      const response = await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'codex', cwd: daemon.workdir, title }) });
      assert.equal(response.status, 201);
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 900 }, isMobile: mobile, hasTouch: mobile, colorScheme });
      try {
        const page = await context.newPage();
        await openUi(page, daemon);
        if (mobile) await page.locator('.menu-btn').click();
        await page.locator('.thread-title', { hasText: title }).first().click();
        const input = page.locator('.composer textarea');
        await input.fill('/');
        await page.getByRole('option', { name: /\/inspect/ }).waitFor();
        for (const command of ['compact', 'review', 'skills', 'mcp']) assert.equal(await page.locator('.command-name').filter({ hasText: `/${command}` }).count(), 1);
        await input.fill('/usage');
        assert.equal(await page.getByRole('option').count(), 1);
        await input.press('Enter');
        const panel = page.getByRole('dialog', { name: /Codex 的额度|额度看板/ });
        await panel.waitFor();
        const boardRow = panel.locator('.quota-board-row').filter({ hasText: 'Codex' });
        const quotaData = await boardRow.count() ? boardRow : panel;
        await quotaData.locator('.quota-row').first().waitFor();
        assert.equal(await quotaData.locator('.quota-row').count(), 3);
        assert.deepEqual(await quotaData.locator('.quota-percent').allTextContents(), ['25%', '82%', '10%']);
        await page.waitForTimeout(400);
        const bounds = await panel.boundingBox();
        assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= page.viewportSize().width + 1 && bounds.y + bounds.height <= page.viewportSize().height + 1);
        if (process.env.RAH_E2E_SHOTS_DIR) {
          mkdirSync(process.env.RAH_E2E_SHOTS_DIR, { recursive: true });
          await page.screenshot({ path: join(process.env.RAH_E2E_SHOTS_DIR, `codex-quota-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`) });
        }
        await panel.getByRole('button', { name: '关闭' }).click();
        await input.fill('/review 检查错误处理');
        await page.getByRole('button', { name: '发送', exact: true }).click();
        await page.getByText('审查完成：检查错误处理', { exact: true }).waitFor();
        await input.fill('/inspect');
        await page.getByRole('option', { name: /\/inspect/ }).waitFor();
        await page.waitForTimeout(400);
        if (process.env.RAH_E2E_SHOTS_DIR) await page.screenshot({ path: join(process.env.RAH_E2E_SHOTS_DIR, `codex-skill-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`) });
        await input.press('Enter');
        await page.getByRole('button', { name: '发送', exact: true }).click();
        await page.getByText(/skills:inspect@/).waitFor();
      } finally { await context.close(); }
    }
  }
});
