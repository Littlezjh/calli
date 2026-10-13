import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, openUi, launchBrowser, repoRoot } from '../harness.mjs';
import { fakeZcodeQuota } from '../../daemon/test/fixtures/fake-zcode-quota.mjs';

test('zcode quota appears in the shared board on desktop and phone, light and dark', async () => {
  const provider = await fakeZcodeQuota();
  let daemon, browser;
  try {
    daemon = await startDaemon({ ZCODE_BIGMODEL_USAGE_API_KEY: 'fixture-key', ZCODE_BIGMODEL_USAGE_QUOTA_URL: provider.url, RAH_AGENTS_JSON: JSON.stringify({ agents: [{ id: 'zcode', adapter: 'zcode', command: [process.execPath, join(repoRoot, 'daemon/test/fixtures/fake-zcode.mjs')] }] }) });
    browser = await launchBrowser();
    for (const mobile of [false, true]) for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, colorScheme });
      try {
        const page = await context.newPage();
        await openUi(page, daemon);
        if (mobile) await page.locator('.menu-btn').click();
        await page.getByRole('button', { name: '配置', exact: true }).click();
        await page.getByRole('menuitem', { name: '额度', exact: true }).click();
        const row = page.locator('.quota-board-row').filter({ has: page.locator('.quota-board-name', { hasText: /zcode/i }) });
        await row.getByText('98%', { exact: true }).waitFor();
        await page.waitForTimeout(600);
        assert.ok(await row.getByText('5H', { exact: true }).isVisible());
        assert.ok(await row.getByText('7D', { exact: true }).isVisible());
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        if (process.env.RAH_E2E_SHOTS_DIR) {
          mkdirSync(process.env.RAH_E2E_SHOTS_DIR, { recursive: true });
          await page.screenshot({ path: join(process.env.RAH_E2E_SHOTS_DIR, `quota-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`) });
        }
      } finally { await context.close(); }
    }
  } finally { await browser?.close(); await daemon?.stop(); await provider.close(); }
});
