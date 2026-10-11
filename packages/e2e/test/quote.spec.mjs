// Quoting a selected passage into the composer, and asking about one in the side chat.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** Picks out the first characters of the thread's first answer, the way a pointer drag would. */
async function selectStartOfAnswer(count) {
  await page.evaluate((n) => {
    const el = document.querySelector('.main .thread .markdown');
    const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, n);
    sel.addRange(range);
  }, count);
}

test('a selection in the answer becomes a quote in the composer and in the sent message', async () => {
  await openUi(page, daemon);
  await page.locator('.composer .context-btn').first().click();
  await page.getByRole('menuitemradio', { name: /^pi/ }).click();
  await page.locator('.composer textarea').click();
  await page.keyboard.type('quoteselect');
  await page.keyboard.press('Enter');
  await page.getByText('hi there quoteselect').waitFor({ timeout: 15_000 });

  await selectStartOfAnswer(7);
  await page.locator('.selection-menu').waitFor({ timeout: 5_000 });
  assert.equal(await page.locator('.selection-menu').innerText(), '引用\n拷贝\n在侧边栏提问');

  // Quoting closes the menu and parks the passage above what is typed.
  await page.locator('.selection-menu button', { hasText: '引用' }).click();
  await page.locator('.quote-strip').waitFor({ timeout: 5_000 });
  assert.equal(await page.locator('.quote-strip').innerText(), 'hi ther');
  assert.equal(await page.locator('.selection-menu').count(), 0);

  await page.locator('.composer textarea').click();
  await page.keyboard.type('why so');
  await page.keyboard.press('Enter');
  await page.locator('.row.user .bubble-quote').last().waitFor({ timeout: 5_000 });
  assert.equal(await page.locator('.row.user .bubble-quote').last().innerText(), 'hi ther');
  assert.equal(await page.locator('.row.user .bubble').last().innerText(), 'why so');
  // Wait for the turn to finish: the side chat in the next test forks this thread, and a fork
  // has to wait for a running turn.
  await page.waitForFunction(
    () => [...document.querySelectorAll('.main .thread .markdown')].some((m) => m.textContent?.includes('hi there > hi ther')),
    null,
    { timeout: 15_000 },
  );
});

test('asking in the side chat opens a thread of its own', async () => {
  await selectStartOfAnswer(7);
  await page.locator('.selection-menu').waitFor({ timeout: 5_000 });
  await page.locator('.selection-menu button', { hasText: '在侧边栏提问' }).click();
  await page.locator('.side-chat').waitFor({ timeout: 5_000 });

  // The passage is what the questions are about; nothing exists on the server yet.
  assert.equal(await page.locator('.side-chat-passage').innerText(), 'hi ther');
  assert.equal(await page.locator('.sidebar .thread-row').count(), 1);

  await page.locator('.side-chat textarea').click();
  await page.keyboard.type('go on');
  await page.keyboard.press('Enter');

  // The message carries the quote, and the side chat forks the conversation it came from: the
  // agent answers with the full history as context, while the panel shows only what is asked
  // here — one user turn, none of the inherited ones.
  await page.locator('.side-chat .row.user .bubble-quote').waitFor({ timeout: 5_000 });
  assert.equal(await page.locator('.side-chat .row.user .bubble-quote').innerText(), 'hi ther');
  assert.equal(await page.locator('.side-chat .row.user .bubble').last().innerText(), 'go on');
  assert.equal(await page.locator('.side-chat .row.user').count(), 1, 'inherited turns stay with the agent, not on the panel');
  await page.waitForFunction(
    () => document.querySelectorAll('.sidebar .thread-row').length === 2,
    null,
    { timeout: 10_000 },
  );
  const titles = await page.locator('.sidebar .thread-row .thread-title').allInnerTexts();
  assert.match(titles.join('\n'), /^追问：hi ther$/m);
  assert.ok((await page.locator('.sidebar .thread-row .thread-fork').count()) >= 1, 'the side chat is marked as a fork');

  // The conversation it came from is untouched underneath.
  assert.equal(await page.locator('.main .thread .markdown').first().innerText(), 'hi there quoteselect');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.side-chat').count(), 0);
});

test('a picture attached to the composer can be looked at full size before sending', async () => {
  await openUi(page, daemon);
  await page.locator('.composer .context-btn').first().click();
  await page.getByRole('menuitemradio', { name: /^pi/ }).click();
  // A one-pixel PNG, the same the fake agent keeps in its canned history.
  const dot = join(daemon.dataDir, 'dot.png');
  writeFileSync(dot, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  await page.setInputFiles('.composer input[type=file]', dot);
  await page.locator('.attachment img').waitFor({ timeout: 5_000 });

  // Tapping the thumbnail opens the picture over everything; closing it changes nothing.
  await page.locator('.attachment-view').click();
  await page.locator('.lightbox').waitFor({ timeout: 3_000 });
  assert.match(await page.locator('.lightbox img').getAttribute('src'), /^blob:/);
  await page.keyboard.press('Escape');
  await page.locator('.lightbox').waitFor({ state: 'detached', timeout: 3_000 });
  assert.equal(await page.locator('.attachment img').count(), 1);

  // Removing the picture still works without opening the preview.
  await page.locator('.attachment-remove').click();
  await page.locator('.attachment img').waitFor({ state: 'detached', timeout: 3_000 });
});
