import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, openUi, api, launchBrowser, repoRoot } from '../harness.mjs';

// The board lays out plan items from their linked threads and what agents report; the person ticks them.
let daemon, browser;
const shots = process.env.RAH_E2E_SHOTS_DIR;
const todos = {};

async function json(path, init) {
  const response = await api(daemon, path, init);
  assert.ok(response.ok, `${path}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}
const post = (path, body) => json(path, { method: 'POST', body: JSON.stringify(body) });
const item = async (id) => (await json('/api/todos')).find((todo) => todo.id === id);
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
  const thread = (title, extra = {}) => post('/api/threads', { agent: 'claude', title, cwd: daemon.workdir, ...extra });
  const working = await thread('重构支付流程');
  const waiting = await thread('发布前检查', { workMode: 'execute', permissionMode: 'ask' });
  todos.review = await post('/api/todos', { text: '支付重构' });
  todos.waiting = await post('/api/todos', { text: '发布 2.0' });
  todos.todo = await post('/api/todos', { text: '首页首屏提速' });
  await post(`/api/todos/${todos.review.id}/threads`, { threadId: working.id });
  await post(`/api/todos/${todos.waiting.id}/threads`, { threadId: waiting.id });
  await post(`/api/threads/${working.id}/turns`, { text: 'report 待验收 diff 已就绪' });
  await post(`/api/threads/${waiting.id}/turns`, { text: 'please approve' });
  await until(async () => (await item(todos.review.id)).report?.stage === 'review', 'the agent report was not recorded');
  const board = (await json('/api/extensions')).find((state) => state.manifest.id === 'board');
  await post('/api/extensions/board/install', { granted: board.manifest.permissions });
});
after(async () => { await browser?.close(); await daemon?.stop(); });

const column = (page, name) => page.locator('.ext-board-column').filter({ has: page.getByRole('heading', { name: new RegExp(`^${name}`) }) });

test('plan items sit where their threads and agents put them, in all layouts', { timeout: 90000 }, async () => {
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
        await page.locator('.ext-board-card', { hasText: '发布 2.0' }).getByText('等你批准').waitFor();
        await page.getByRole('tab', { name: /待验收/ }).click();
        await page.locator('.ext-board-card', { hasText: '支付重构' }).getByText('diff 已就绪').waitFor();
      } else {
        await column(page, '等你').locator('.ext-board-card', { hasText: '发布 2.0' }).getByText('等你批准').waitFor();
        const review = column(page, '待验收').locator('.ext-board-card', { hasText: '支付重构' });
        await review.getByText('diff 已就绪').waitFor();
        await review.getByText('agent 请你验收').waitFor();
        await column(page, '未开始').locator('.ext-board-card', { hasText: '首页首屏提速' }).getByText('未关联线程').waitFor();
      }
      if (shots) await page.screenshot({ path: join(shots, `board-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`), animations: 'disabled' });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'the board fits the viewport');
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, []);
});

test('the person ticks an item done from the board, and the agent report gives way', async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    await openUi(page, daemon);
    await page.goto(daemon.base + '/#/board');
    await page.getByRole('checkbox', { name: '标记完成: 支付重构' }).click();
    await column(page, '已完成').locator('.ext-board-card', { hasText: '支付重构' }).waitFor();
    const done = await item(todos.review.id);
    assert.deepEqual([done.done, done.report], [true, null]);
    // A card opens the thread that put it where it is.
    await column(page, '等你').locator('.ext-board-card', { hasText: '发布 2.0' }).click();
    await page.locator('.composer-slot').waitFor();
    assert.equal(await page.locator('.ext-board-page').count(), 0);
  } finally { await page.close(); }
});
