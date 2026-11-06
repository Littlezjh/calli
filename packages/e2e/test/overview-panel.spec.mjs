// The overview panel: one top-bar button, the team and the thread's work under it, a change's
// whole history in a dialog, and the page preview beside the row. Checked against a live daemon
// for the reading, and against the demo workspace for the tall panel that must not scroll.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDaemon, launchBrowser, openUi, api } from '../harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits for a thread to stop running, and stay stopped. */
async function idle(daemon, threadId) {
  for (let i = 0; i < 300; i++) {
    const res = await api(daemon, `/api/threads/${threadId}`);
    const thread = await res.json();
    if (thread.status !== 'running') {
      await sleep(300);
      if ((await (await api(daemon, `/api/threads/${threadId}`)).json()).status !== 'running') return thread;
    } else await sleep(100);
  }
  throw new Error(`thread ${threadId} never settled`);
}

test('the overview panel reads the thread from one top-bar button, and a change opens its diff', { timeout: 180000 }, async () => {
  const daemon = await startDaemon();
  const browser = await launchBrowser();
  try {
    const made = await (await api(daemon, '/api/threads', {
      method: 'POST', body: JSON.stringify({ agent: 'claude', cwd: daemon.workdir, title: '概况面板' }),
    })).json();
    await api(daemon, `/api/threads/${made.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'edit file make outputs plan' }) });
    await idle(daemon, made.id);
    // The same file edited again in a later turn: its row holds both turns' diffs. The plan comes
    // with it, or the newest turn would stand between the panel and the plan before it.
    await api(daemon, `/api/threads/${made.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'edit file again plan' }) });
    await idle(daemon, made.id);

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await openUi(page, daemon);
    await page.locator('.thread-row', { hasText: '概况面板' }).click();

    // The lean bar: the overview, the files and the one more menu — nothing else.
    await page.locator('.topbar-overview').waitFor();
    assert.equal(await page.locator('.topbar-actions button.icon-btn').count(), 3, 'three top-bar buttons');
    assert.equal(await page.locator('.topbar-agents, .topbar-plan, .topbar-trace').count(), 0, 'no old buttons came back');

    // The panel: plan, changes, images and files, in that order.
    await page.locator('.topbar-overview').click();
    const panel = page.locator('.overview-panel');
    await panel.waitFor();
    await panel.locator('.overview-row', { hasText: 'app.ts' }).waitFor();
    const groups = await panel.locator('.overview-toggle strong').allTextContents();
    assert.deepEqual(groups.slice(0, 4), ['计划', '变更', '图片', '文件']);
    assert.equal(await panel.locator('.overview-plan .plan-entry').count(), 3);
    assert.ok(await panel.locator('.overview-picture img').count() > 0, 'the chart shows a thumbnail');

    // A change row opens every turn's diff for that file, read from history/detail.
    await panel.locator('.overview-row', { hasText: 'app.ts' }).click();
    const diff = page.locator('.change-diff-dialog');
    await diff.waitFor();
    await diff.locator('.diff-line.add', { hasText: 'const c = 4' }).first().waitFor();
    const head = await diff.locator('.change-diff-head').innerText();
    assert.match(head, /app\.ts/);
    assert.match(head, /\+4/);
    assert.match(head, /共 2 轮/);
    // Newest turn first, one section each.
    assert.deepEqual(await diff.locator('.change-diff-turn h3').allTextContents(), ['第 2 轮', '第 1 轮']);
    await diff.locator('.change-diff-head .icon-btn').click();
    await diff.waitFor({ state: 'detached' });

    // The page has its own preview button beside the row, apart from opening the file.
    await page.locator('.topbar-overview').click();
    const htmlRow = page.locator('.overview-rowwrap', { hasText: 'report.html' }).first();
    await htmlRow.locator('.overview-row').waitFor();
    await htmlRow.locator('.overview-row').hover();
    await htmlRow.locator('.overview-preview').click();
    await page.locator('.preview-scrim').waitFor();
    assert.match(await page.locator('.preview-name').innerText(), /report\.html/);
    await page.locator('.preview-bar').getByRole('button', { name: '关闭预览' }).click();
    await page.locator('.preview-scrim').waitFor({ state: 'detached' });

    // The more menu keeps the terminal and the trace beside the thread.
    await page.locator('.topbar-more').click();
    await page.getByRole('menuitem', { name: '打开终端', exact: true }).waitFor();
    await page.getByRole('menuitem', { name: '轨迹', exact: true }).waitFor();
    await page.keyboard.press('Escape');

    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
    await daemon.stop();
  }
});

test('a full team and thirteen changes fold into the room the panel has, with no scrollbar', { timeout: 120000 }, async () => {
  const daemon = await startDaemon();
  const browser = await launchBrowser();
  try {
    // The demo workspace: four members (one needing the user, one failed, one running), a plan,
    // thirteen changes, nine pictures and five files — more than the panel can show at once.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${daemon.base}/`);
    await page.locator('.thread-row', { hasText: '上线前收尾' }).click();
    await page.locator('.topbar-overview').click();
    const panel = page.locator('.overview-panel');
    await panel.waitFor();
    await panel.locator('.overview-member', { hasText: '深色核对' }).waitFor();
    // The badge counts only what asks for the person.
    assert.equal((await page.locator('.topbar-overview .topbar-badge').innerText()).trim(), '1');
    // Four members show their attention rows first; the rest wait behind one more line.
    assert.ok(await panel.locator('.overview-member').count() >= 3);
    await panel.locator('.overview-more').first().waitFor();
    // The last groups folded rather than the panel growing a scrollbar.
    const fit = await panel.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight, bottom: el.getBoundingClientRect().bottom }));
    assert.ok(fit.scroll <= fit.client + 1, `panel scrolls: ${fit.scroll} > ${fit.client}`);
    assert.ok(fit.bottom <= 900, `panel runs past the window: ${fit.bottom}`);
    // The groups that folded say so by not showing their rows; the agents never fold.
    assert.ok(await panel.locator('.overview-group.open .overview-member').count() >= 3, 'the agents stay open');
    await context.close();
  } finally {
    await browser.close();
    await daemon.stop();
  }
});
