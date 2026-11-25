import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDaemon, launchBrowser, openUi, api } from '../harness.mjs';

test('sidebar done fold sits as a same-row glass pill beside settings and opens an upward popover', { timeout: 90000 }, async () => {
  const daemon = await startDaemon();
  const browser = await launchBrowser();
  try {
    const active = await (await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: daemon.workdir, title: '进行中对话' }) })).json();
    const finished = await (await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: daemon.workdir, title: '已归档历史任务' }) })).json();
    await api(daemon, `/api/threads/${finished.id}`, { method: 'PATCH', body: JSON.stringify({ done: true }) });
    assert.ok(active.id && finished.id);

    for (const mobile of [false, true]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 820 }, isMobile: mobile, hasTouch: mobile, colorScheme: theme });
      const page = await context.newPage(); page.setDefaultTimeout(10000);
      const errors = []; page.on('pageerror', err => errors.push(err.message));
      await openUi(page, daemon);
      if (mobile) await page.getByRole('button', { name: '打开线程列表', exact: true }).click();

      const pill = page.locator('.sidebar-float .done-fold-pill');
      await pill.waitFor();
      assert.equal(await page.locator('.done-fold-popover').count(), 0, 'done popover starts closed');

      const geom = await page.evaluate(() => {
        const p = document.querySelector('.sidebar-float .done-fold-pill').getBoundingClientRect();
        const s = document.querySelector('.sidebar-float .round-btn').getBoundingClientRect();
        const sb = document.querySelector('.sidebar-inner').getBoundingClientRect();
        return {
          pillBottom: sb.bottom - p.bottom,
          settingsBottom: sb.bottom - s.bottom,
          centerDelta: Math.abs((p.top + p.height / 2) - (s.top + s.height / 2)),
          overlap: p.right > s.left + 1,
          overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        };
      });
      assert.ok(geom.centerDelta <= 2, `done pill aligns on the same row as settings, delta=${geom.centerDelta}`);
      assert.ok(geom.pillBottom < 40, `done pill sits near bottom edge with no dead gap, bottom=${geom.pillBottom}`);
      assert.equal(geom.overlap, false, 'done pill never overlaps settings button');
      assert.equal(geom.overflow, false, 'no horizontal overflow');

      // Open popover, check done item is visible, dismiss with Escape, reopen and select it.
      await pill.click();
      const pop = page.locator('.done-fold-popover');
      await pop.waitFor();
      await pop.locator('.thread-item', { hasText: '已归档历史任务' }).waitFor();
      await page.keyboard.press('Escape');
      assert.equal(await pop.count(), 0, 'Escape dismisses done popover');

      await pill.click();
      await pop.locator('.thread-item', { hasText: '已归档历史任务' }).click();
      assert.equal(await pop.count(), 0, 'selecting a done thread closes popover');
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally {
    await browser.close();
    await daemon.stop();
  }
});
