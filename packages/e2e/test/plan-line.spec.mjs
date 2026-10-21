import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, openUi, api, launchBrowser, repoRoot } from '../harness.mjs';

test('the agent plan folds to one quiet line and opens to the whole list', { timeout: 120000 }, async () => {
  const daemon = await startDaemon({ RAH_AGENTS_JSON: JSON.stringify({ agents: [{ id: 'codex', adapter: 'codex', command: [process.execPath, join(repoRoot, 'daemon/test/fixtures/fake-codex.mjs')] }] }) });
  const shots = process.env.RAH_E2E_SHOTS_DIR;
  if (shots) mkdirSync(shots, { recursive: true });
  let browser;
  try {
    browser = await launchBrowser();
    for (const mobile of [false, true]) for (const colorScheme of ['light', 'dark']) {
      const title = `计划行 ${mobile ? '手机' : '桌面'} ${colorScheme}`;
      const res = await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'codex', title, cwd: daemon.workdir, permissionMode: 'full_access' }) });
      assert.equal(res.status, 201);
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, colorScheme });
      try {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        await openUi(page, daemon);
        if (mobile) await page.locator('.menu-btn').click();
        await page.locator('.thread-title', { hasText: title }).first().click();
        await page.locator('.composer textarea').fill('longplan tool slow');
        await page.getByRole('button', { name: '发送', exact: true }).click();

        // Folded: the count and the step it is on, on one line; the list itself is not drawn.
        const toggle = page.locator('.plan-toggle');
        await toggle.filter({ hasText: '计划 1/5' }).waitFor();
        assert.match(await toggle.innerText(), /Pull every root request/);
        assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
        assert.equal(await page.locator('.plan-list').count(), 0, 'the list is not drawn until asked for');
        const box = await toggle.boundingBox();
        assert.ok(box.height <= 32, `the folded plan stays one line (${box.height}px)`);
        if (shots) await page.screenshot({ path: join(shots, `plan-line-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`) });

        await toggle.click();
        assert.equal(await page.locator('.plan-entry').count(), 5);
        assert.equal(await page.locator('.plan-entry.active').count(), 1);
        if (shots) await page.screenshot({ path: join(shots, `plan-open-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`) });

        // Stopped: nothing is in progress any more, so the line names no current step.
        await page.getByRole('button', { name: '停止', exact: true }).click();
        await page.locator('.plan-entry.active').waitFor({ state: 'detached' });
        assert.equal((await toggle.innerText()).trim(), '计划 1/5');
        assert.deepEqual(errors, []);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
      } finally { await context.close(); }
    }
  } finally { await browser?.close(); await daemon.stop(); }
});
