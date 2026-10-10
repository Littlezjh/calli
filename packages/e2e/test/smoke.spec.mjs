// Smoke test for the e2e harness itself: sign in, pick an agent, run one turn, see the answer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildOnce, startDaemon, openUi, api, launchBrowser } from '../harness.mjs';

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

test('signs in and lists agents', async () => {
  await openUi(page, daemon);
  const agents = await (await api(daemon, '/api/agents')).json();
  assert.ok(agents.some((a) => a.id === 'pi' && a.available));
  assert.ok(agents.some((a) => a.id === 'claude' && a.available));
});

test('picks pi, sends a message, sees the streamed answer', async () => {
  await openUi(page, daemon);
  // The draft composer's agent picker is the first context button in the header.
  await page.locator('.composer .context-btn').first().click();
  await page.getByRole('menuitemradio', { name: /pi/ }).click();
  await page.locator('.composer textarea').click();
  await page.keyboard.type('hello');
  await page.keyboard.press('Enter');
  await page.getByText('hi there hello').waitFor({ timeout: 20_000 });
});
