import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, openUi, api, launchBrowser } from '../harness.mjs';

const box = (page, selector) => page.locator(selector).first().evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { left: Math.round(r.left), right: Math.round(r.right), center: Math.round(r.left + r.width / 2) };
});

test('a running conversation leans toward the middle of a wide screen; a new thread, a hidden list and a phone stay centred', async () => {
  const daemon = await startDaemon();
  let browser;
  try {
    const post = async (path, body) => (await api(daemon, path, { method: 'POST', body: JSON.stringify(body) })).json();
    const thread = await post('/api/threads', { agent: 'claude', cwd: daemon.workdir, title: '居中对比' });
    await post(`/api/threads/${thread.id}/turns`, { text: 'run a streamed command' });
    for (let i = 0; i < 100 && (await (await api(daemon, `/api/threads/${thread.id}`)).json()).status !== 'idle'; i++) await new Promise((r) => setTimeout(r, 100));
    browser = await launchBrowser();
    const shots = process.env.CALLI_E2E_SHOTS_DIR;
    if (shots) mkdirSync(shots, { recursive: true });

    for (const colorScheme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1000 }, colorScheme });
      await openUi(page, daemon);
      const sidebar = await box(page, '.sidebar');
      assert.equal(sidebar.right - sidebar.left, 360, 'a wide window gets the wide list');
      const areaCenter = Math.round((sidebar.right + 1920) / 2);

      // A new thread: centred beside the list.
      await page.locator('.composer-box').waitFor();
      assert.ok(Math.abs((await box(page, '.composer-box')).center - areaCenter) <= 1, 'the new thread page stays centred');
      if (shots) await page.screenshot({ path: join(shots, `lean-new-${colorScheme}.png`) });

      // A conversation: everything that lines up with the column moves left together, by half
      // of the way to the screen's middle (90px here), and the top bar stays where it was.
      await page.locator('.thread-item', { hasText: '居中对比' }).click();
      // A finished turn's work is folded to one line, and commands in a row to one more.
      await page.locator('.work-toggle').first().click();
      await page.locator('.run-head').first().click();
      const step = page.locator('.step', { hasText: 'npm test -- --grep upload' });
      await step.waitFor();
      await page.waitForTimeout(400);
      const column = await box(page, '.thread');
      const composer = await box(page, '.composer-box');
      assert.equal(column.center, areaCenter - 90, 'the column leans toward the middle');
      assert.ok(Math.abs(composer.center - column.center) <= 1, 'the composer moves with the column');
      assert.equal((await box(page, '.topbar')).right, 1920, 'the top bar still reaches the edge');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

      // The command a step ran is its title and the first line of its detail.
      assert.equal((await step.locator('.step-title').innerText()).trim(), '运行了 npm test -- --grep upload');
      await step.locator('.step-head').click();
      assert.equal((await step.locator('.step-command').innerText()).trim(), 'npm test -- --grep upload');
      if (shots) await page.screenshot({ path: join(shots, `lean-thread-${colorScheme}.png`) });

      // With the list put away the column is already in the middle.
      await page.getByRole('button', { name: '隐藏侧边栏' }).first().click();
      await page.waitForTimeout(400);
      assert.ok(Math.abs((await box(page, '.thread')).center - 960) <= 1, 'no lean without the list');
      await page.getByRole('button', { name: '显示侧边栏' }).first().click();
      await page.close();
    }

    // The demo workspace: its bar lines up with the composer once a conversation leans.
    const demo = await browser.newPage({ viewport: { width: 1920, height: 1000 } });
    await demo.goto(daemon.base + '/');
    await demo.locator('.demo-bar').waitFor();
    await demo.locator('.thread-item').first().click();
    await demo.waitForTimeout(400);
    const bar = await box(demo, '.demo-bar');
    assert.equal(bar.center, (await box(demo, '.composer-box')).center, 'the demo bar moves with the composer');
    assert.ok(await demo.locator('.main.lean').count(), 'a demo conversation leans as well');
    if (shots) await demo.screenshot({ path: join(shots, 'lean-demo.png') });
    await demo.close();

    // A phone has no list beside the column: nothing leans.
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await openUi(phone, daemon);
    await phone.locator('.menu-btn').click();
    await phone.locator('.thread-item', { hasText: '居中对比' }).click();
    await phone.locator('.thread').waitFor();
    // The conversation slides in over the list; measure it once it has arrived.
    await phone.waitForFunction(() => { const r = document.querySelector('.thread')?.getBoundingClientRect(); return r && r.left >= 0 && r.right <= innerWidth; });
    assert.equal(await phone.locator('.main.lean').count(), 0);
    const onPhone = await box(phone, '.thread');
    assert.ok(onPhone.left >= 0 && onPhone.right <= 390, `the column stays on the screen (${JSON.stringify(onPhone)})`);
    if (shots) await phone.screenshot({ path: join(shots, 'lean-phone.png') });
  } finally {
    await browser?.close();
    await daemon.stop();
  }
});
