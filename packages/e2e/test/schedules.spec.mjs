// The scheduled-task page: create a task from the form, run it by hand, and see the run land as
// a thread that says a schedule started it.
import { test, before, after } from 'node:test';
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

test('schedules: the page creates a task, runs it now, and the run shows up as a thread', async () => {
  await openUi(page, daemon);
  await page.getByRole('button', { name: '定时任务', exact: true }).click();
  await page.locator('.sched-page').waitFor();
  // Nothing yet: the page says so and offers the way in.
  await page.locator('.sched-empty').waitFor();

  // The form: name, prompt, and the daily preset writing a cron of its own.
  await page.getByRole('button', { name: '新建任务' }).click();
  await page.getByRole('dialog', { name: '新建任务' }).waitFor();
  await page.getByLabel('名称').fill('构建巡检');
  // The fake pi answers "hi there <prompt>", so the run is easy to recognise.
  await page.getByRole('radio', { name: 'pi' }).click();
  await page.getByLabel('提示词').fill(`早上好，看看 {{date}} 的构建`);
  await page.getByRole('radio', { name: '每天' }).click();
  await page.getByLabel('运行时间').fill('09:30');
  await page.getByRole('button', { name: '创建任务' }).click();
  await page.locator('.sched-card').waitFor();

  const card = page.locator('.sched-card', { hasText: '构建巡检' });
  await card.locator('.sched-freq', { hasText: '每天 09:30' }).waitFor();
  await card.locator('.sched-meta', { hasText: '下次' }).waitFor();

  // Run it by hand from the card's menu.
  await card.locator('.icon-btn').click();
  await page.getByRole('menuitem', { name: '立即运行' }).click();

  // The run lands as a thread, named for the task and its day, marked as started by a schedule.
  const row = page.locator('.thread-row', { hasText: /构建巡检 · \d{4}-\d{2}-\d{2}/ });
  await row.waitFor({ timeout: 15_000 });
  await row.click();
  await page.locator('.term-chip', { hasText: '定时' }).waitFor();
  // The prompt went out with the date filled in, and the fake agent answered.
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  await page.locator('.bubble', { hasText: `早上好，看看 ${date} 的构建` }).waitFor();
  await page.getByText('hi there', { exact: false }).waitFor({ timeout: 15_000 });

  // The run history says how it went, and points at the thread.
  await page.getByRole('button', { name: '定时任务', exact: true }).click();
  await card.click();
  await page.getByRole('dialog', { name: '编辑任务' }).waitFor();
  const history = page.locator('.sched-runs li', { hasText: '已完成' });
  await history.waitFor({ timeout: 10_000 });
  await history.getByRole('button', { name: '查看会话' }).click();
  await page.locator('.term-chip', { hasText: '定时' }).waitFor();
});

test('schedules: the switch stops a task without deleting it', async () => {
  await (
    await api(daemon, '/api/schedules', { method: 'POST', body: JSON.stringify({ name: '周报', agent: 'pi', cwd: daemon.workdir, prompt: '写周报', cron: '0 9 * * mon', mode: 'new' }) })
  ).json();
  await page.reload();
  await page.locator('.sidebar-inner').waitFor();
  await page.getByRole('button', { name: '定时任务', exact: true }).click();
  const card = page.locator('.sched-card', { hasText: '周报' });
  await card.locator('.sched-meta', { hasText: '下次' }).waitFor();

  await card.getByRole('switch', { name: '停用这个任务' }).click();
  await card.locator('.sched-meta', { hasText: '已停用' }).waitFor();
  await card.getByRole('switch', { name: '启用这个任务' }).click();
  await card.locator('.sched-meta', { hasText: '下次' }).waitFor();

  // Deleting asks first, and keeps the threads it made.
  await card.locator('.icon-btn').click();
  await page.getByRole('menuitem', { name: '删除' }).click();
  await page.getByRole('dialog', { name: '删除定时任务' }).waitFor();
  await page.getByRole('button', { name: '删除' }).click();
  // The card goes when the delete comes back; waiting for it is the check.
  await page.locator('.sched-card', { hasText: '周报' }).waitFor({ state: 'detached' });
  await page.locator('.sched-card', { hasText: '构建巡检' }).waitFor();
});
