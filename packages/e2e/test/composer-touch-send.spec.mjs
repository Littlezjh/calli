import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDaemon, openUi, api, launchBrowser } from '../harness.mjs';

test('touching send submits even when the keyboard blur swallows the click', async () => {
  const daemon = await startDaemon();
  const browser = await launchBrowser();
  const post = async (path, body) => {
    const response = await api(daemon, path, { method: 'POST', body: JSON.stringify(body) });
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  };
  try {
    const title = `首点发送 ${Date.now()}`;
    await post('/api/threads', { agent: 'pi', cwd: daemon.workdir, title });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const page = await context.newPage();
      await openUi(page, daemon);
      await page.locator('.menu-btn').tap();
      await page.locator('.thread-row').filter({ hasText: title }).tap();
      await page.evaluate(() => {
        document.addEventListener('pointerdown', event => {
          const button = event.target instanceof Element ? event.target.closest('.composer .send-btn:not(.stop)') : null;
          if (!button) return;
          // Some mobile browsers first let the focused input lose focus, which closes the keyboard.
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        }, true);
        document.addEventListener('click', event => {
          const button = event.target instanceof Element ? event.target.closest('.composer .send-btn:not(.stop)') : null;
          if (!button) return;
          event.preventDefault();
          event.stopImmediatePropagation();
        }, true);
      });
      const input = page.locator('.composer textarea');
      await input.tap();
      await input.fill('mobile first tap send');
      await page.locator('.composer .send-btn:not(.stop)').tap();
      await page.getByText('hi there mobile first tap send').waitFor({ timeout: 15_000 });
      assert.equal(await input.inputValue(), '');
    } finally { await context.close(); }
  } finally { await browser.close(); await daemon.stop(); }
});
