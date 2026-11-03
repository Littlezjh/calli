import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, openUi, api, launchBrowser, repoRoot } from '../harness.mjs';

test('the newest plan sits in the top bar and opens to the whole list; older plans stay in the conversation', { timeout: 120000 }, async () => {
  const daemon = await startDaemon({ CALLI_AGENTS_JSON: JSON.stringify({ agents: [{ id: 'codex', adapter: 'codex', command: [process.execPath, join(repoRoot, 'daemon/test/fixtures/fake-codex.mjs')] }] }) });
  const shots = process.env.CALLI_E2E_SHOTS_DIR;
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

        // The newest turn's plan is a top-bar button: the ring and the count.
        const button = page.locator('.topbar-plan');
        await button.and(page.getByRole('button', { name: '计划 1/5', exact: true })).waitFor();
        assert.equal((await button.innerText()).trim(), '1/5');
        assert.equal(await page.locator('.plan-toggle').count(), 0, 'it is not shown in the conversation as well');
        assert.equal(await page.locator('.plan-list').count(), 0, 'the list is not drawn until asked for');
        const box = await button.boundingBox();
        const files = await page.locator('.topbar-files').boundingBox();
        assert.equal(box.height, files.height, 'the button is as tall as its neighbours');
        assert.ok(Math.abs(box.y - files.y) < 1, 'and on the same line');
        if (shots) await page.screenshot({ path: join(shots, `plan-line-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`) });

        await button.click();
        const panel = page.locator('.plan-panel');
        await panel.waitFor();
        await page.waitForTimeout(400); // the panel's entrance, so the picture is of the panel at rest
        assert.equal(await panel.locator('.plan-entry').count(), 5);
        assert.equal(await panel.locator('.plan-entry.active').count(), 1);
        assert.match(await panel.locator('.plan-entry.active').innerText(), /Pull every root request/);
        if (shots) await page.screenshot({ path: join(shots, `plan-open-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`) });
        const inside = await panel.boundingBox();
        assert.ok(inside.x >= 0 && inside.x + inside.width <= (mobile ? 390 : 1440), 'the panel stays on screen');

        // Stopped: nothing is in progress any more.
        await page.keyboard.press('Escape');
        await panel.waitFor({ state: 'detached' });
        await page.getByRole('button', { name: '停止', exact: true }).click();
        await button.click();
        await panel.waitFor();
        await panel.locator('.plan-entry.active').waitFor({ state: 'detached' });
        await page.keyboard.press('Escape');

        // A new message: the old plan goes back into the conversation, where its turn is.
        await page.locator('.composer textarea').fill('hello');
        await page.getByRole('button', { name: '发送', exact: true }).click();
        await page.locator('.plan-toggle').filter({ hasText: '计划 1/5' }).waitFor();
        await button.waitFor({ state: 'detached' });
        assert.deepEqual(errors, []);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
      } finally { await context.close(); }
    }
  } finally { await browser?.close(); await daemon.stop(); }
});
