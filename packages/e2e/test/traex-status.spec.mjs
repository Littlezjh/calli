import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon, openUi, launchBrowser } from '../harness.mjs';

test('TRAE model load and weekly quota appear in existing controls in both themes and sizes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'calli-traex-ui-'));
  let daemon, browser;
  try {
    const fixtures = fileURLToPath(new URL('../../daemon/test/fixtures/', import.meta.url));
    const fakeCodex = join(home, 'fake-codex');
    writeFileSync(fakeCodex, `#!/bin/sh\nexec '${process.execPath}' '${join(fixtures, 'fake-codex.mjs')}' "$@"\n`, { mode: 0o755 });
    daemon = await startDaemon({ CALLI_CODEX_BIN: fakeCodex, CALLI_CLAUDE_QUOTA_BIN: join(fixtures, 'fake-claude-usage.sh'), HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'), CALLI_TRAEX_BIN: 'fake-claude', FAKE_ACP_FLAVOR: 'traex' });
    browser = await launchBrowser();
    const shots = process.env.CALLI_TRAEX_SHOTS;
    if (shots) mkdirSync(shots, { recursive: true });
    for (const phone of [false, true]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 960 }, isMobile: phone, hasTouch: phone, colorScheme: theme });
      const page = await context.newPage();
      await page.addInitScript((token) => localStorage.setItem('calli.token', token), daemon.token);
      await openUi(page, daemon);
      await page.locator('.composer .context-btn').first().click();
      await page.getByRole('menuitemradio', { name: /^TRAE CLI/ }).click();
      await page.locator('.model-control-trigger').click();
      const inlineLoad = page.locator('.effort-model .model-inline-load');
      await inlineLoad.waitFor();
      assert.equal(await inlineLoad.innerText(), '184%');
      assert.equal(await inlineLoad.getAttribute('title'), '负载 184%');
      assert.equal(await page.locator('.model-control-trigger .model-inline-load').count(), phone ? 0 : 1);
      await page.getByRole('button', { name: /^切换模型，当前/ }).click();
      await page.getByText(/模型负载 184%.*每周额度剩余 99%/).waitFor();
      assert.equal(await page.getByText(/模型负载 0%/).count(), 1);
      await page.waitForTimeout(300);
      if (shots) await page.screenshot({ path: join(shots, `${phone ? 'phone' : 'desktop'}-${theme}-models.png`) });
      await page.keyboard.press('Escape');
      if (phone) await page.locator('.menu-btn').click();
      await page.getByRole('button', { name: '配置', exact: true }).click();
      await page.getByRole('menuitem', { name: '额度', exact: true }).click();
      const row = page.locator('.quota-board-row', { hasText: 'TRAE CLI' });
      await row.locator('.quota-cell:not(.quota-none)').waitFor();
      assert.match(await page.locator('.quota-board-row').first().innerText(), /TRAE CLI/);
      assert.equal(await row.locator('.quota-percent').innerText(), '99%');
      // An overloaded model is marked on its cell; the load itself is in the cell's detail.
      await row.locator('.quota-busy').waitFor();
      await row.locator('.quota-cell:not(.quota-none)').click();
      assert.equal(await row.locator('.quota-load').innerText(), '负载 184%');
      assert.match(await row.locator('.quota-detail-name').innerText(), /Big 1\.0/, 'the model a window covers is in its detail');
      await row.locator('.quota-cell:not(.quota-none)').click();
      await row.getByRole('button', { name: '刷新 TRAE CLI 的额度' }).click();
      await row.getByText(/按模型显示每周额度/).waitFor();
      const settled = () => row.locator('button:enabled[aria-label="刷新 TRAE CLI 的额度"]').waitFor();
      await settled();
      await Promise.all([
        page.waitForRequest((r) => r.url().includes('/api/agents/traex/quota?refresh=1')),
        page.getByRole('button', { name: '全部刷新' }).click(),
      ]);
      await settled();
      await page.waitForTimeout(300);
      if (shots) await page.screenshot({ path: join(shots, `${phone ? 'phone' : 'desktop'}-${theme}-quota.png`) });
      await context.close();
    }
  } finally {
    await browser?.close();
    await daemon?.stop();
    rmSync(home, { recursive: true, force: true });
  }
});
