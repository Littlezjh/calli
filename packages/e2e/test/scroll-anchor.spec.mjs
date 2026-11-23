import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { api, startDaemon, openUi, launchBrowser, repoRoot } from '../harness.mjs';

let hub, browser, dataDir, workdir;
const variants = [false, true].flatMap(mobile => ['light', 'dark'].map(theme => ({ mobile, theme, name: `anchor-${mobile}-${theme}`, id: randomUUID() })));
const otherId = randomUUID();
const shots = process.env.CALLI_E2E_SHOTS_DIR;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'calli-scroll-data-'));
  workdir = mkdtempSync(join(tmpdir(), 'calli-scroll-work-'));
  const { Store } = await import(join(repoRoot, 'daemon/dist/store.js'));
  const store = new Store(dataDir);
  for (const { id, name } of [...variants, { id: otherId, name: 'other' }]) {
    store.createThread({ id, agent: 'pi', cwd: workdir, title: name, permissionMode: 'auto_edit', model: null, effort: null });
    store.transaction(() => {
      for (let i = 1; i <= 40; i++) {
        const picture = join(workdir, `chart-${i}.svg`);
        writeFileSync(picture, '<svg xmlns="http://www.w3.org/2000/svg" width="700" height="700"><rect width="700" height="700" fill="#aabbcc" /></svg>');
        const add = (type, data) => store.appendEvent(id, `t${i}`, type, data);
        add('turn.started', { text: `Question ${i}` });
        const text = Array.from({ length: 12 }, (_, line) => `Answer ${i} paragraph ${line}, with enough text to measure the reading position.`).join('\n\n');
        add('message.delta', { text: text + (i <= 38 ? `\n\nThe chart is here: ${picture}` : '') });
        add('turn.done', { stopReason: 'end_turn' });
      }
    });
  }
  store.close();
  hub = await startDaemon({ CALLI_DATA_DIR: dataDir, CALLI_WORKDIRS: workdir });
  browser = await launchBrowser();
  if (shots) mkdirSync(shots, { recursive: true });
});

after(async () => {
  await browser?.close();
  await hub?.stop();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workdir, { recursive: true, force: true });
});

const deferred = () => {
  let release;
  return { promise: new Promise(resolve => { release = resolve; }), release: () => release() };
};
const position = page => page.locator('.thread .row.user[data-turn="t39"]').evaluate(el => el.getBoundingClientRect().top);
const scroller = page => page.locator('.main > .scroller');
const open = async (page, id) => {
  await openUi(page, hub);
  await page.evaluate(id => { location.hash = `#/thread/${id}`; }, id);
  await page.locator('.thread .row.user[data-turn="t40"]').waitFor();
  await page.waitForTimeout(300);
};

for (const variant of variants) {
  test(`paging and delayed images preserve reading; new replies below do not steal it (${variant.name})`, async () => {
    const context = await browser.newContext({ viewport: variant.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: variant.mobile, hasTouch: variant.mobile, colorScheme: variant.theme });
    const page = await context.newPage();
    const older = deferred(), pictures = deferred();
    const requests = [];
    page.on('request', request => { if (request.url().includes(`/threads/${variant.id}/history?before=`)) requests.push(request.url()); });
    try {
      await open(page, variant.id);
      await page.route(`**/threads/${variant.id}/history?before=*`, async route => { await older.promise; await route.continue(); });
      await page.route(`**/threads/${variant.id}/files?*`, async route => { await pictures.promise; await route.continue(); });
      // Hold the page until the wheel has stopped: the test measures insertion, not a second gesture.
      await page.mouse.move(variant.mobile ? 200 : 850, 400);
      await page.mouse.wheel(0, -600);
      await page.waitForTimeout(300);
      const before = await position(page);
      older.release();
      await page.waitForFunction(() => document.querySelector('.thread').querySelectorAll('.bubble').length === 10);
      await page.waitForTimeout(150);
      assert.ok(Math.abs(await position(page) - before) <= 2, 'the same message stays in place after the history commit');
      assert.equal(await page.locator('.file-image img').count(), 0, 'pictures are still loading');
      pictures.release();
      await page.waitForFunction(() => {
        const images = [...document.querySelectorAll('.thread .file-image img')];
        return images.length === 8 && images.every(image => image.complete && image.naturalHeight > 0);
      });
      await page.waitForTimeout(150);
      const afterImages = await position(page);
      assert.ok(Math.abs(afterImages - before) <= 2, `late images above the reading do not move its message (${before} -> ${afterImages})`);
      assert.equal(requests.length, 1, 'restoring the position does not load another history page');
      if (shots) await page.screenshot({ path: join(shots, `${variant.name}.png`), animations: 'disabled' });

      const response = await api(hub, `/api/threads/${variant.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'New reply below the reading\n\n' + 'Another paragraph below the reading.\n\n'.repeat(30) }) });
      assert.ok(response.ok, `sending a fake turn: ${response.status} ${response.ok ? '' : await response.text()}`);
      await page.getByText('hi there New reply below the reading', { exact: false }).waitFor();
      await page.waitForTimeout(150);
      assert.ok(Math.abs(await position(page) - before) <= 2, 'streamed content below an unpinned reading leaves it in place');

      // Going to the latest is deliberate navigation and must not be undone by the old anchor.
      await page.locator('.jump-anchor button').first().click();
      await page.waitForFunction(() => {
        const el = document.querySelector('.main > .scroller');
        return el.scrollHeight - el.scrollTop - el.clientHeight < 2;
      });
    } finally {
      older.release(); pictures.release();
      await context.close();
    }
  });
}

test('a late history response cannot restore the position of another conversation', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const older = deferred();
  try {
    await open(page, variants[0].id);
    await page.route(`**/threads/${variants[0].id}/history?before=*`, async route => { await older.promise; await route.continue(); });
    const requested = page.waitForRequest(request => request.url().includes(`/threads/${variants[0].id}/history?before=`));
    await page.mouse.move(850, 400); await page.mouse.wheel(0, -100_000); await requested;
    await page.evaluate(id => { location.hash = `#/thread/${id}`; }, otherId);
    await page.locator('.topbar-title', { hasText: 'other' }).waitFor();
    await page.locator('.thread .row.user[data-turn="t40"]').waitFor();
    await page.waitForTimeout(200);
    const before = await scroller(page).evaluate(el => el.scrollTop);
    older.release();
    await page.waitForTimeout(400);
    assert.equal(await scroller(page).evaluate(el => el.scrollTop), before);
    assert.equal(await page.locator('.thread .bubble').count(), 2);
  } finally { older.release(); await context.close(); }
});

test('paging past thirty turns and unfolding them keeps the existing message in place', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  try {
    await open(page, otherId);
    for (let n = 0; n < 8 && await page.locator('.thread .bubble').count() < 40; n++) {
      const older = page.locator('.thread .older-messages');
      await page.waitForFunction(() => !document.querySelector('.thread .file-image.loading'));
      await older.scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);
      const row = page.locator('.thread .row.user').first();
      const existingRow = await row.elementHandle();
      const images = page.locator('.thread .file-image img');
      const existingImage = await images.count() ? await images.first().elementHandle() : null;
      const imageSource = existingImage ? await existingImage.getAttribute('src') : null;
      const turnId = await row.getAttribute('data-turn');
      const before = await row.evaluate(el => el.getBoundingClientRect().top);
      const count = await page.locator('.thread .bubble').count();
      await older.click();
      await page.waitForFunction(count => document.querySelector('.thread').querySelectorAll('.bubble').length > count, count);
      await page.waitForFunction(() => !document.querySelector('.thread .file-image.loading'));
      await page.waitForTimeout(150);
      const after = await page.locator(`.thread .row.user[data-turn="${turnId}"]`).evaluate(el => el.getBoundingClientRect().top);
      assert.ok(Math.abs(after - before) <= 2, `paging or unfolding preserves ${turnId} (${before} -> ${after})`);
      assert.equal(await existingRow.evaluate(el => el.isConnected), true, 'prepending retains the existing message node');
      if (existingImage) {
        assert.equal(await existingImage.evaluate(el => el.isConnected), true, 'prepending retains the already loaded image');
        assert.equal(await existingImage.getAttribute('src'), imageSource);
      }
    }
    assert.equal(await page.locator('.thread .bubble').count(), 40);
    assert.equal(await page.locator('.thread .older-messages').count(), 0);
    assert.equal(await page.locator('.thread .file-image img').count(), 38);
  } finally { await context.close(); }
});
