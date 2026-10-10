// How a turn is shown: thinking as its own collapsible section, tool rows with verbs and
// durations, the work group collapsing once the turn is done.
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

test('a turn shows thinking, verb-first tool rows, and folds its work away when done', async () => {
  await openUi(page, daemon);
  await page.locator('.composer .context-btn').first().click();
  await page.getByRole('menuitemradio', { name: /^pi/ }).click();
  await page.locator('.composer textarea').click();
  await page.keyboard.type('slowthink');
  await page.keyboard.press('Enter');

  // While it runs: the work group is open, thinking is expanded and says so.
  await page.locator('.thinking').waitFor({ timeout: 10_000 });
  assert.match(await page.locator('.thinking-toggle').innerText(), /思考中/);

  // Tool rows appear while the turn is still running, verb first; the one in flight says so.
  await page.locator('.step').first().waitFor({ timeout: 10_000 });
  assert.match(await page.locator('.step-title').first().innerText(), /^运行了\s+ls/);
  const inFlight = page.locator('.step', { hasText: 'npm test' });
  await inFlight.waitFor({ timeout: 10_000 });
  assert.equal((await inFlight.locator('.step-status').innerText()).trim(), '运行中');

  // Once the turn is done the work folds to one line and thinking collapses with a duration.
  await page.getByText('hi there slowthink').waitFor({ timeout: 15_000 });
  await page.locator('.work-toggle', { hasText: '用时' }).first().waitFor({ timeout: 10_000 });
  const toggle = await page.locator('.work-toggle').first().innerText();
  assert.match(toggle, /用时/);
  assert.match(toggle, /1 步/);

  // Expanding the work group again: thinking is one collapsed line, the step is there.
  await page.locator('.work-toggle').first().click();
  await page.locator('.step').first().waitFor({ state: 'visible' });
  assert.match(await page.locator('.thinking-toggle').innerText(), /^思考/);
  assert.equal(await page.locator('.thinking-para').count(), 0);

  // Thinking itself expands into its paragraphs.
  await page.locator('.thinking-toggle').first().click();
  await page.locator('.thinking-para').first().waitFor({ state: 'visible' });
  assert.match(await page.locator('.thinking-para').first().innerText(), /hmm/);
});
