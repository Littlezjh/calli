// The web terminal: opens from the thread header (desktop) and the thread menu (phone), runs a
// real shell on the host, survives its panel being closed and reopened, and ends cleanly.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildOnce, startDaemon, openUi, api, launchBrowser } from '../harness.mjs';

let daemon;
let browser;

before(async () => {
  await buildOnce();
  // /bin/sh keeps the test off the user's rc files and shell prompt.
  daemon = await startDaemon({ RAH_TERM_SHELL: '/bin/sh' });
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  await daemon?.stop();
});

/** Waits until the rendered terminal text contains `needle`. */
async function termShows(page, needle, timeout = 15_000) {
  await page.waitForFunction(
    (n) => document.querySelector('.term-body')?.textContent?.includes(n) ?? false,
    needle,
    { timeout },
  );
}

async function openThreadWithTerminalButton(page, title) {
  await openUi(page, daemon);
  const thread = await (
    await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: daemon.workdir, title }) })
  ).json();
  // On a phone the list is a page of its own, behind the menu button.
  if (await page.locator('.menu-btn').isVisible()) await page.locator('.menu-btn').click();
  await page.locator('.thread-item', { hasText: title }).click();
  return thread;
}

test('the header button opens a terminal that runs commands and survives closing', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  try {
    await openThreadWithTerminalButton(page, '终端桌面');
    await page.getByLabel('打开终端').click();
    await page.locator('.term-panel').waitFor();

    await page.locator('.term-body').click();
    await page.keyboard.type('echo e2e-ok');
    await page.keyboard.press('Enter');
    await termShows(page, 'e2e-ok');

    // Closing the panel hides the terminal; reopening reattaches and replays what already ran.
    await page.getByLabel('关闭').click();
    assert.equal(await page.locator('.term-panel').count(), 0);
    await page.getByLabel('打开终端').click();
    await page.locator('.term-panel').waitFor();
    await termShows(page, 'e2e-ok');
    assert.equal(await page.locator('.term-note').count(), 0, 'the reopened terminal is live, not ended');

    // Exiting the shell ends the panel's session and offers a fresh one.
    await page.locator('.term-body').click();
    await page.keyboard.type('exit');
    await page.keyboard.press('Enter');
    await page.locator('.term-note', { hasText: '终端已结束' }).waitFor();
    await page.getByRole('button', { name: '重新打开' }).click();
    await page.locator('.term-note').waitFor({ state: 'detached' });
    await page.locator('.term-body').click();
    await page.keyboard.type('echo again-ok');
    await page.keyboard.press('Enter');
    await termShows(page, 'again-ok');
  } finally {
    await ctx.close();
  }
});

test('on a phone the terminal opens from the thread menu', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await ctx.newPage();
  try {
    await openThreadWithTerminalButton(page, '终端手机');
    await page.getByLabel('这个线程的更多操作').click();
    await page.getByRole('menuitem', { name: '打开终端' }).click();
    await page.locator('.term-panel').waitFor();

    await page.locator('.term-body').click();
    await page.keyboard.type('echo m-ok');
    await page.keyboard.press('Enter');
    await termShows(page, 'm-ok');
  } finally {
    await ctx.close();
  }
});

test('the slash menu opens the terminal', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  try {
    await openThreadWithTerminalButton(page, '终端斜杠');
    await page.locator('.composer textarea').click();
    await page.keyboard.type('/终端');
    await page.getByRole('option', { name: /终端/ }).click();
    await page.locator('.term-panel').waitFor();
    await termShows(page, '$');
  } finally {
    await ctx.close();
  }
});
