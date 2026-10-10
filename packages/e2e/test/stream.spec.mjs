// Stream order and pinning: a tool call made after text must render below that text (like
// Codex), the newest content stays pinned to the bottom while a turn runs, and scrolling up
// hands the position to the user until they jump back.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildOnce, startDaemon, openUi, api, launchBrowser } from '../harness.mjs';

let daemon;
let browser;
let page;
let threadId;

before(async () => {
  await buildOnce();
  daemon = await startDaemon();
  browser = await launchBrowser();
  // Phone-sized, like the screens this behaviour matters on.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  page = await ctx.newPage();
});

after(async () => {
  await browser?.close();
  await daemon?.stop();
});

const scrollState = () =>
  page.evaluate(() => {
    const el = document.querySelector('.scroller');
    return {
      dist: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
      jump: !!document.querySelector('.jump-btn'),
    };
  });

const openThreadByTitle = async (title) => {
  await page.locator('.menu-btn').click();
  await page.locator('.thread-title', { hasText: title }).first().click();
  await page.waitForTimeout(800);
};

test('a slow turn keeps stream order and stays pinned to the bottom', async () => {
  await openUi(page, daemon);
  const made = await (await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: daemon.workdir }) })).json();
  threadId = made.id;
  await openThreadByTitle('New thread');

  // Start the slow turn with the thread open, so the interleaved events can be watched live.
  await api(daemon, `/api/threads/${threadId}/turns`, { method: 'POST', body: JSON.stringify({ text: 'slowthink one' }) });

  // The turn interleaves group → text → group; the DOM must keep that order, newest at the end.
  // Checked while it still runs, so the step rows are on screen.
  await page.waitForFunction(() => document.querySelectorAll('.thread .work').length >= 2, undefined, { timeout: 20_000 });
  const order = await page.evaluate(() => {
    const kids = Array.from(document.querySelector('.thread').children);
    const works = kids.map((k, i) => (k.classList.contains('work') ? i : -1)).filter((i) => i >= 0);
    const text = kids.findIndex((k) => k.querySelector('.markdown')?.textContent?.includes('hi there slowthink one'));
    const titles = kids.flatMap((k) => [...k.querySelectorAll('.step-title')].map((s) => s.textContent));
    return { first: works[0], text, last: works[works.length - 1], titles };
  });
  assert.ok(order.first < order.text && order.text < order.last, `text must sit between the two groups: ${JSON.stringify(order)}`);
  assert.equal(order.titles.filter((t) => t?.includes('npm test')).length, 1, 'the second group renders its step row');
  assert.equal(order.titles.filter((t) => t?.includes('ls')).length, 1, 'the first group renders its step row');

  // Through the rest of the run: the view never leaves the bottom, the jump button stays hidden.
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(250);
    const state = await scrollState();
    assert.equal(state.dist, 0, `sample ${i}: the view must stay pinned to the bottom`);
    assert.equal(state.jump, false, `sample ${i}: no jump button while pinned`);
  }

  // Done: the first group carries the turn duration, later groups read as handled, both collapse.
  await page.waitForFunction(
    () => {
      const heads = [...document.querySelectorAll('.thread .work-toggle')].map((b) => b.textContent ?? '');
      return heads.some((h) => h.includes('用时')) && heads.filter((h) => h.includes('已处理')).length >= 1;
    },
    undefined,
    { timeout: 20_000 },
  );
  assert.equal(await page.locator('.thread .work-body').count(), 0, 'finished groups collapse');
});

test('scrolling up hands the position to the user; jumping back re-pins for the next turn', async () => {
  // Filler turns so the thread is taller than the screen and can actually be scrolled.
  for (let i = 0; i < 6; i++) {
    await api(daemon, `/api/threads/${threadId}/turns`, { method: 'POST', body: JSON.stringify({ text: `filler ${i}` }) });
    await page.waitForTimeout(350);
  }
  await page.waitForTimeout(600);

  // Wheel over the conversation area, not over the top bar.
  await page.mouse.move(195, 400);
  await page.mouse.wheel(0, -900);
  await page.waitForTimeout(400);
  const up = await scrollState();
  assert.ok(up.dist > 300, `the view stays where the user scrolled (dist=${up.dist})`);
  assert.equal(up.jump, true, 'the jump button appears');

  await page.locator('.jump-btn').click();
  await page.waitForTimeout(900);
  const back = await scrollState();
  assert.ok(back.dist < 60, 'jump returns to the bottom');
  assert.equal(back.jump, false);

  // A second slow turn while pinned: still glued to the bottom as it streams.
  await api(daemon, `/api/threads/${threadId}/turns`, { method: 'POST', body: JSON.stringify({ text: 'slowthink two' }) });
  for (let i = 0; i < 9; i++) {
    await page.waitForTimeout(300);
    const state = await scrollState();
    assert.equal(state.dist, 0, `sample ${i}: pinned through the second turn`);
  }
  await page.getByText('hi there slowthink two').waitFor({ timeout: 15_000 });
});
