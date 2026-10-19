import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, openUi, api, launchBrowser, repoRoot } from '../harness.mjs';

// The board lays out conversations by what they are doing and what their agents report; the person marks them done.
let daemon, browser;
const shots = process.env.RAH_E2E_SHOTS_DIR;
const threads = {};

async function json(path, init) {
  const response = await api(daemon, path, init);
  assert.ok(response.ok, `${path}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}
const post = (path, body) => json(path, { method: 'POST', body: JSON.stringify(body) });
const view = (id) => json(`/api/threads/${id}`);
async function until(check, message) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error(message);
}

before(async () => {
  daemon = await startDaemon({ RAH_AGENTS_JSON: JSON.stringify({ agents: [
    { id: 'claude', adapter: 'claude', label: 'Claude Code', command: [process.execPath, join(repoRoot, 'daemon/test/fixtures/fake-acp.mjs')] },
  ] }) });
  browser = await launchBrowser();
  if (shots) mkdirSync(shots, { recursive: true });
  const create = (title, extra = {}) => post('/api/threads', { agent: 'claude', title, cwd: daemon.workdir, ...extra });
  threads.before = await create('装看板之前');
  await post(`/api/threads/${threads.before.id}/turns`, { text: 'report 待验收 不该被读到' });
  await until(async () => (await view(threads.before.id)).status === 'idle', 'the first turn did not end');

  const board = (await json('/api/extensions')).find((state) => state.manifest.id === 'board');
  assert.ok(board.manifest.permissions.includes('progress.report'));
  await post('/api/extensions/board/install', { granted: board.manifest.permissions });
  threads.review = await create('重构支付流程');
  threads.waiting = await create('发布前检查', { workMode: 'execute', permissionMode: 'ask' });
  await post(`/api/threads/${threads.review.id}/turns`, { text: 'report 待验收 diff 已就绪' });
  await post(`/api/threads/${threads.waiting.id}/turns`, { text: 'please approve' });
  await until(async () => (await view(threads.review.id)).report?.stage === 'review', 'the progress line was not recorded');
  assert.equal((await view(threads.before.id)).report ?? null, null, 'nobody was asked before consent');
});
after(async () => { await browser?.close(); await daemon?.stop(); });

const column = (page, name) => page.locator('.ext-board-column').filter({ has: page.getByRole('heading', { name: new RegExp(`^${name}`) }) });
const card = (scope, title) => scope.locator('.ext-board-card-wrap', { hasText: title });

test('conversations sit where their state and agents put them, in all layouts', { timeout: 90000 }, async () => {
  const errors = [];
  for (const mobile of [false, true]) for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 900 }, isMobile: mobile, hasTouch: mobile, colorScheme });
    try {
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      await openUi(page, daemon);
      await page.goto(daemon.base + '/#/board');
      if (mobile) {
        // Phones open on what needs the person.
        await page.getByRole('tab', { name: /等你/, selected: true }).waitFor();
        await card(page, '发布前检查').getByText('等你批准').waitFor();
        await page.getByRole('tab', { name: /待验收/ }).click();
        await card(page, '重构支付流程').getByText('diff 已就绪').waitFor();
      } else {
        await card(column(page, '等你'), '发布前检查').getByText('等你批准').waitFor();
        const review = card(column(page, '待验收'), '重构支付流程');
        await review.getByText('diff 已就绪').waitFor();
        await review.getByText('agent 请你验收').waitFor();
        await card(column(page, '待验收'), '装看板之前').getByText('有新结果').waitFor();
      }
      if (shots) await page.screenshot({ path: join(shots, `board-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`), animations: 'disabled' });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'the board fits the viewport');
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, []);
});

test('the person marks a conversation done, and new work reopens it', async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    await openUi(page, daemon);
    await page.goto(daemon.base + '/#/board');
    await page.getByRole('checkbox', { name: '标记完成: 重构支付流程' }).click();
    await card(column(page, '已完成'), '重构支付流程').waitFor();
    const done = await view(threads.review.id);
    assert.ok(done.doneAt);
    assert.equal(done.report, null);

    await post(`/api/threads/${threads.review.id}/turns`, { text: 'report 进行中 等 CI' });
    await card(column(page, '进行中'), '重构支付流程').getByText('等 CI').waitFor();
    assert.equal((await view(threads.review.id)).doneAt, null);

    // A card opens its conversation.
    await card(column(page, '等你'), '发布前检查').locator('.ext-board-card').click();
    await page.locator('.composer-slot').waitFor();
    assert.equal(await page.locator('.ext-board-page').count(), 0);
  } finally { await page.close(); }
});
