// A phone keyboard covers the bottom of the page, and the browser pans what is left of the screen
// (the visual viewport) down the page to the focused field. The app must be drawn where that is.
// A real keyboard cannot be raised here, so the visual viewport is given the numbers a phone
// reports, and the layout is checked against them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildOnce, startDaemon, openUi, launchBrowser } from '../harness.mjs';

let daemon;
let browser;
let page;

before(async () => {
  await buildOnce();
  daemon = await startDaemon();
  browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  page = await ctx.newPage();
});

after(async () => {
  await browser?.close();
  await daemon?.stop();
});

/** Makes the visual viewport report a keyboard: `height` of screen left, panned `top` down the page. */
const keyboard = (height, top) =>
  page.evaluate(
    ([h, t]) => {
      const vv = window.visualViewport;
      for (const [name, value] of Object.entries({ height: h, offsetTop: t, pageTop: t, scale: 1 })) {
        Object.defineProperty(vv, name, { get: () => value, configurable: true });
      }
      vv.dispatchEvent(new Event('resize'));
      vv.dispatchEvent(new Event('scroll'));
    },
    [height, top],
  );

const box = (selector) => page.locator(selector).first().evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
});

test('with the keyboard up, the app fills what is left of the screen, wherever the browser panned to', async () => {
  await openUi(page, daemon);
  assert.deepEqual(await box('.app'), { top: 0, bottom: 844, height: 844 });

  // Keyboard up: 500px of screen left, and Safari has panned 344px down to reach the field.
  await keyboard(500, 344);
  assert.deepEqual(await box('.app'), { top: 344, bottom: 844, height: 500 }, 'the app is the visible part, not the top of the page');
  const composer = await box('.composer-box');
  assert.ok(composer.bottom <= 844 && composer.bottom > 844 - 60, `the composer sits just above the keyboard (${composer.bottom})`);
  assert.ok((await box('.topbar')).top === 344, 'the top bar is at the top of what is visible');

  // Layers over the app stay on the visible part too: the plan page, with its own field.
  await page.locator('.menu-btn').click();
  await page.locator('.sidebar').getByRole('button', { name: '计划' }).click();
  await page.waitForTimeout(500); // the sheet slides in
  const sheet = await box('.todos-panel');
  assert.ok(sheet.top >= 344 && sheet.bottom <= 844, `the sheet is inside the visible part (${sheet.top}–${sheet.bottom})`);
  await page.locator('.todos-panel .icon-btn').click();

  // Keyboard down again: back to the whole screen.
  await keyboard(844, 0);
  assert.deepEqual(await box('.app'), { top: 0, bottom: 844, height: 844 });
});
