// A phone keyboard covers the bottom of the page, and the browser pans what is left of the screen
// (the visual viewport) down the page to the focused field. The app must be drawn where that is.
// A real keyboard cannot be raised here, so the visual viewport is given the numbers a phone
// reports, and the layout is checked against them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildOnce, startDaemon, openUi, launchBrowser, api } from '../harness.mjs';

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
  const safeBottom = () => page.evaluate(() => document.documentElement.style.getPropertyValue('--safe-bottom'));
  assert.equal(await safeBottom(), '0px', 'the home-indicator inset is under the keyboard, so no band is kept for it');

  // The plan page lives in the same visible part, and its line for a new plan can be typed on.
  await page.locator('.menu-btn').click();
  await page.locator('.sidebar').getByRole('button', { name: '计划' }).click();
  await page.waitForTimeout(500); // the list slides away
  const field = await box('.todos-page .todo-add');
  assert.ok(field.top >= 344 && field.bottom <= 844, `the new-plan line is inside the visible part (${field.top}–${field.bottom})`);

  // Keyboard down again: back to the whole screen.
  await keyboard(844, 0);
  assert.deepEqual(await box('.app'), { top: 0, bottom: 844, height: 844 });
  assert.equal(await safeBottom(), '', 'with the keyboard down the inset is kept clear again');
});

test('a comment on a passage is written just above the keyboard, with the passage shown', async () => {
  await openUi(page, daemon);
  await page.locator('.composer .context-btn').first().click();
  await page.getByRole('menuitemradio', { name: /^pi/ }).click();
  await page.locator('.composer textarea').fill('notekeyboard');
  await page.locator('.composer .send-btn, .composer button[aria-label="发送"]').first().tap();
  await page.getByText('hi there notekeyboard').waitFor({ timeout: 15_000 });
  await page.locator('.composer textarea').blur();

  await page.evaluate(() => {
    const el = document.querySelector('.main .thread .markdown');
    const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 8);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
  // The system's own menu (copy, look up) is above the passage; this one goes under it.
  await page.locator('.selection-menu').waitFor({ timeout: 5_000 });
  const passage = await page.evaluate(() => getSelection().getRangeAt(0).getBoundingClientRect().bottom);
  assert.ok((await box('.selection-menu')).top >= passage + 20, 'the menu is under the passage, clear of its handle');
  await page.locator('.selection-menu button', { hasText: '注释' }).tap();
  await page.locator('.selection-comment').waitFor({ timeout: 5_000 });

  // The field takes the focus, the keyboard comes up and Safari pans down the page.
  await keyboard(500, 344);
  const field = await box('.selection-menu.commenting');
  assert.ok(field.top >= 344 && field.bottom <= 844 && field.bottom > 844 - 80, `the field sits just above the keyboard (${field.top}–${field.bottom})`);
  assert.equal(await page.locator('.selection-quote').innerText(), 'hi there');

  await page.locator('.selection-comment').fill('为什么');
  await page.locator('.selection-add').tap();
  await page.locator('.composer .note-strip, .composer .notes').first().waitFor({ timeout: 5_000 });
  assert.equal(await page.locator('.selection-menu').count(), 0);
  await keyboard(844, 0);
});

test('with the keyboard up, the terminal and its input line stay on the visible part', async () => {
  await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: daemon.workdir, title: '键盘终端' }) });
  await openUi(page, daemon);
  await page.locator('.menu-btn').click();
  await page.locator('.thread-item', { hasText: '键盘终端' }).click();
  await page.getByLabel('这个线程的更多操作').click();
  await page.getByRole('menuitem', { name: '打开终端' }).click();
  await page.locator('.term-panel').waitFor();

  // The field at the bottom takes the focus; Safari pans down to it.
  await keyboard(500, 344);
  assert.deepEqual(await box('.term-panel'), { top: 344, bottom: 844, height: 500 }, 'the terminal is the visible part, not pushed below it');
  const line = await box('.term-line');
  assert.ok(line.top >= 344 && line.bottom <= 844, `the input line is on screen (${line.top}–${line.bottom})`);
  await keyboard(844, 0);
  await page.getByLabel('关闭').click();
});

test('with the keyboard up, the side chat on a phone stays on the visible part', async () => {
  await page.locator('.composer textarea').fill('sidekeyboard');
  await page.locator('.composer .send-btn').first().tap();
  await page.getByText('hi there sidekeyboard').waitFor({ timeout: 15_000 });
  await page.locator('.composer textarea').blur();
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.main .thread .markdown')].pop();
    const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 8);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.locator('.selection-menu button', { hasText: '在侧边栏提问' }).tap();
  await page.locator('.side-chat').waitFor();

  await keyboard(500, 344);
  const panel = await box('.side-chat');
  assert.ok(panel.top >= 344 && panel.bottom <= 844, `the side chat is the visible part (${panel.top}–${panel.bottom})`);
  const field = await box('.side-chat textarea');
  assert.ok(field.top >= 344 && field.bottom <= 844, `its field is on screen (${field.top}–${field.bottom})`);
  await keyboard(844, 0);
});
