// The plan page: a list of the user's own plans with sub-items, ticked off when done and linked
// to the threads that work on them.
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
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await ctx.newPage();
  const thread = await (await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: daemon.workdir }) })).json();
  await api(daemon, `/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'write the release notes' }) });
});

after(async () => {
  await browser?.close();
  await daemon?.stop();
});

const plan = (text) => page.locator('.todos-panel .todo:not(.child)', { hasText: text });
const newPlan = () => page.getByLabel('新计划');

test('plans and sub-items are added, each on its own line, and ticked off', async () => {
  await openUi(page, daemon);
  await page.locator('.foot-link', { hasText: '计划' }).click();
  await page.getByText('还没有计划').waitFor();

  await newPlan().fill('发布 0.2');
  // Enter while an input method is still composing belongs to it: nothing is added yet.
  await newPlan().evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.todos-panel .todo').count(), 0);
  await newPlan().press('Enter');
  await plan('发布 0.2').waitFor();
  assert.equal(await newPlan().inputValue(), '', 'the line is ready for the next plan');

  // Sub-items come several at a time: the field stays open, and typing in it is its own text.
  await plan('发布 0.2').locator('.row-more').first().click();
  await page.getByRole('menuitem', { name: '加子项' }).click();
  const sub = page.getByLabel('新子项');
  await sub.fill('写更新说明');
  assert.equal(await newPlan().inputValue(), '', 'a sub-item being typed does not show up in the new-plan line');
  await sub.press('Enter');
  await sub.fill('打 tag');
  await sub.press('Enter');
  await sub.press('Escape');
  const children = plan('发布 0.2').locator('.todo.child');
  await children.nth(1).waitFor();
  assert.deepEqual(await children.locator('.todo-text').allTextContents(), ['写更新说明', '打 tag']);
  const [a, b] = await Promise.all([children.nth(0).boundingBox(), children.nth(1).boundingBox()]);
  assert.ok(Math.abs(a.x - b.x) < 1 && b.y >= a.y + a.height - 1, 'sub-items stack, one under the other');
  assert.equal(await page.locator('.todos-panel').count(), 1, 'Escape closed the field, not the page');

  // A sub-item is struck through where it is; a finished plan moves down to the done group.
  await children.nth(0).locator('.todo-check').click();
  await plan('发布 0.2').locator('.todo.child .todo-text.done', { hasText: '写更新说明' }).waitFor();
  await newPlan().fill('清理重复轮次');
  await newPlan().press('Enter');
  await plan('清理重复轮次').locator('.todo-check').first().click();
  await page.locator('.todos-done-head', { hasText: '已完成 1' }).waitFor();
  assert.equal(await plan('清理重复轮次').count(), 0, 'done plans are folded away');
  await page.locator('.todos-done-head').click();
  await plan('清理重复轮次').locator('.todo-text.done').waitFor();
});

test('a plan links to a thread; the chip opens it', async () => {
  await plan('发布 0.2').locator('.row-more').first().click();
  await page.getByRole('menuitem', { name: '关联线程' }).click();
  await page.getByRole('menuitem', { name: 'write the release notes' }).click();
  const chip = plan('发布 0.2').locator('.todo-chip', { hasText: 'write the release notes' });
  await chip.waitFor();

  // It survives a reload: plans live on the daemon, not in the page.
  await page.reload();
  await page.locator('.foot-link', { hasText: '计划' }).click();
  await chip.locator('.todo-chip-name').click();
  await page.locator('.todos-panel').waitFor({ state: 'detached' });
  assert.match(await page.locator('.topbar-title').innerText(), /write the release notes/);
});

test('deleting a plan asks first, and leaves the page open', async () => {
  await page.locator('.foot-link', { hasText: '计划' }).click();
  await newPlan().fill('写错的一条');
  await newPlan().press('Enter');
  await plan('写错的一条').locator('.row-more').first().click();
  await page.getByRole('menuitem', { name: '删除' }).click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await plan('写错的一条').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.todos-panel').count(), 1);
  await plan('发布 0.2').waitFor();
});
