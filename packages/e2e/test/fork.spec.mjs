// The fork button at the bottom-left of the composer: one click copies the whole thread and
// opens the copy, the way Codex does it. It only appears once there is a conversation to fork.
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
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  page = await ctx.newPage();
});

after(async () => {
  await browser?.close();
  await daemon?.stop();
});

const forkButton = () => page.locator('.composer-bar button[aria-label="分叉"]');

test('a fresh draft has no fork button: there is nothing to fork yet', async () => {
  await openUi(page, daemon);
  await page.locator('.composer textarea').waitFor();
  assert.equal(await forkButton().count(), 0);
});

test('the fork button copies the thread and opens the copy', async () => {
  await page.locator('.composer .context-btn').first().click();
  await page.getByRole('menuitemradio', { name: /^pi/ }).click();
  await page.locator('.composer textarea').click();
  await page.keyboard.type('hello fork');
  await page.keyboard.press('Enter');
  await page.getByText('hi there hello fork').waitFor({ timeout: 10_000 });

  // The button sits in the composer's bottom bar, next to the attach button.
  await forkButton().waitFor();
  await forkButton().click();

  // The copy opens: the title carries the fork mark, and the conversation came with it.
  await page.locator('.topbar-title', { hasText: '（分叉）' }).waitFor({ timeout: 10_000 });
  await page.getByText('hello fork').first().waitFor({ timeout: 5_000 });
  await page.getByText('hi there hello fork').waitFor({ timeout: 5_000 });

  // The copy goes on from where the original stood: it answers as its own session.
  await page.locator('.composer textarea').click();
  await page.keyboard.type('second turn');
  await page.keyboard.press('Enter');
  await page.getByText('hi there second turn').waitFor({ timeout: 10_000 });
  assert.equal((await page.locator('.topbar-title').innerText()).includes('（分叉）'), true);
});
