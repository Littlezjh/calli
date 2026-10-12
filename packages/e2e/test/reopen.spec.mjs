// Reopening a long thread: the newest turn shows whole, from its question, however many events
// it took; older turns come a page at a time from the top, without moving what is on screen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOnce, startDaemon, openUi, launchBrowser, repoRoot } from '../harness.mjs';

let daemon;
let browser;
let page;
let dataDir;
let workdir;

/** More events than one page of history reaches back, so each turn below is a page of its own. */
const LONG_TURN = 21_000;

before(async () => {
  await buildOnce();
  dataDir = mkdtempSync(join(tmpdir(), 'rah-e2e-long-'));
  workdir = mkdtempSync(join(tmpdir(), 'rah-e2e-long-work-'));
  // The log is written directly: streaming this much through a fake agent would take minutes.
  const { Store } = await import(join(repoRoot, 'daemon', 'dist', 'store.js'));
  const store = new Store(dataDir);
  store.createThread({ id: 'long', agent: 'pi', cwd: workdir, title: 'long thread', permissionMode: 'auto_edit', model: null, effort: null });
  store.transaction(() => {
    for (const name of ['first', 'second', 'latest']) {
      const add = (type, data) => store.appendEvent('long', name, type, data);
      add('turn.started', { text: `${name} question` });
      for (let i = 0; i < LONG_TURN; i++) add('reasoning.delta', { text: 'thinking. ' });
      add('tool.start', { id: `${name}-ls`, title: 'ls', kind: 'execute', status: 'in_progress' });
      add('tool.end', { id: `${name}-ls`, status: 'completed', output: 'a.txt' });
      for (let i = 0; i < 40; i++) add('message.delta', { text: `${name} answer line ${i}\n\n` });
      add('turn.done', { stopReason: 'end_turn' });
    }
  });
  store.close();

  daemon = await startDaemon({ RAH_DATA_DIR: dataDir, RAH_WORKDIRS: workdir });
  browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, permissions: ['clipboard-read', 'clipboard-write'] });
  page = await ctx.newPage();
});

after(async () => {
  await browser?.close();
  await daemon?.stop();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

const questions = () => page.locator('.thread .bubble').allTextContents();
const view = () =>
  page.evaluate(() => {
    const el = document.querySelector('.scroller');
    const latest = [...document.querySelectorAll('.thread .bubble')].find((b) => b.textContent?.includes('latest question'));
    return {
      dist: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
      latestTop: latest ? Math.round(latest.getBoundingClientRect().top) : null,
    };
  });

test('the newest turn opens whole and at the bottom; older turns page in from the top', async () => {
  await openUi(page, daemon);
  const requests = [];
  page.on('request', (r) => {
    if (r.url().includes('/events?')) requests.push(r.url().split('/events?')[1]);
  });
  await page.locator('.menu-btn').click();
  await page.locator('.thread-title', { hasText: 'long thread' }).first().click();

  // The turn is longer than a page reaches back, and its question is there all the same.
  await page.getByText('latest answer line 39').waitFor({ timeout: 15_000 });
  assert.deepEqual(await questions(), ['latest question']);
  assert.equal((await view()).dist, 0, 'a reopened thread sits at its newest line');
  assert.deepEqual(requests, ['tail=1']);

  // Scrolling near the top loads a page automatically. Hold its response to measure the
  // viewport before prepending, rather than clicking again and inadvertently loading two pages.
  let releaseOlder;
  const holdOlder = new Promise((resolve) => { releaseOlder = resolve; });
  await page.route('**/events?before=*', async (route) => {
    await holdOlder;
    await route.continue();
  });
  const toTop = async () => {
    await page.mouse.move(195, 400);
    await page.mouse.wheel(0, -200_000);
    await page.waitForFunction(() => document.querySelector('.scroller').scrollTop === 0, undefined, { timeout: 5000 });
  };
  await toTop();
  const older = page.getByRole('button', { name: '加载更早的消息' });
  const before = await view();
  releaseOlder();
  await page.getByText('second question').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(300);
  assert.deepEqual(await questions(), ['second question', 'latest question']);
  const afterLoad = await view();
  assert.ok(Math.abs(afterLoad.latestTop - before.latestTop) <= 4, `what was on screen stays put (${before.latestTop} → ${afterLoad.latestTop})`);

  // The last page reaches the start of the log, and the button goes away.
  await toTop();
  await page.getByText('first question').waitFor({ timeout: 15_000 });
  assert.deepEqual(await questions(), ['first question', 'second question', 'latest question']);
  await page.waitForTimeout(300);
  assert.equal(await older.count(), 0, 'nothing older is left to load');
});

test('copying the conversation takes all of it, not only the turns on screen', async () => {
  // A fresh visit: only the newest turn is loaded.
  await openUi(page, daemon);
  await page.locator('.menu-btn').click();
  await page.locator('.thread-title', { hasText: 'long thread' }).first().click();
  await page.getByText('latest answer line 39').waitFor({ timeout: 15_000 });
  assert.deepEqual(await questions(), ['latest question']);

  await page.locator('.composer textarea').click();
  await page.keyboard.type('/export');
  await page.keyboard.press('Enter');
  await page.getByText('已复制对话').waitFor({ timeout: 15_000 });
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  for (const name of ['first', 'second', 'latest']) {
    assert.ok(copied.includes(`${name} question`) && copied.includes(`${name} answer line 39`), `the ${name} turn is in the copy`);
  }
});
