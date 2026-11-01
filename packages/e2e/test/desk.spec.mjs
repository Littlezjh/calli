import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDaemon, launchBrowser, api, openUi } from '../harness.mjs';

const json = async (daemon, path, method = 'GET', body) => {
  const response = await api(daemon, path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, `${method} ${path}: ${response.status}`);
  return response.status === 204 ? null : response.json();
};
const openDesk = async page => {
  await page.evaluate(() => { location.hash = '#/desk'; });
  await page.locator('.desk-lanes').waitFor();
};

test('the desk loads notes on demand, saves lanes, and returns keyboard focus after a checklist request', async () => {
  const daemon = await startDaemon();
  const browser = await launchBrowser();
  try {
    const todo = await json(daemon, '/api/todos', 'POST', { text: '整理实验结论', lane: 'you' });
    const child = await json(daemon, '/api/todos', 'POST', { text: '补齐对照组', parentId: todo.id });
    await json(daemon, `/api/todos/${todo.id}/note`, 'PUT', { text: '## 做到哪\n实验已经跑完。\n## 下一步\n写成一页纸。' });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    let noteRequests = 0;
    page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/note')) noteRequests++; });
    await openUi(page, daemon);
    await openDesk(page);
    assert.equal(noteRequests, 0, 'covers use the short preview without requesting notes');
    const pile = page.locator(`#desk-pile-${todo.id}`);
    await pile.click();
    await page.locator('.desk-note-section.next').waitFor();
    assert.equal(noteRequests, 1);
    assert.equal(await page.locator('.desk-note-section h3').first().textContent(), '下一步');
    await page.getByRole('checkbox', { name: child.text }).click();
    await page.locator('.desk-checklist [aria-checked="true"]').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.desk-spread').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement.id), `desk-pile-${todo.id}`);
    assert.equal((await json(daemon, '/api/todos')).find(item => item.id === child.id).done, true);
    await pile.click();
    await page.locator('.desk-lane-picker').click();
    await page.getByRole('menuitemradio', { name: '等别人', exact: true }).click();
    await page.locator('.desk-lane-picker', { hasText: '等别人' }).waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.desk-spread').waitFor({ state: 'detached' });
    assert.equal((await json(daemon, '/api/todos')).find(item => item.id === todo.id).lane, 'wait');
    await page.getByRole('button', { name: '按时间', exact: true }).click();
    await page.reload();
    await page.locator('.desk-lanes.time').waitFor();
    assert.equal(new URL(page.url()).hash, '#/desk');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await daemon.stop(); }
});

test('the phone desk exposes proposal decisions, chart details and delegate destinations', async () => {
  const daemon = await startDaemon();
  const browser = await launchBrowser();
  try {
    for (const text of ['周五前交报销', '确认合同修改']) await json(daemon, '/api/todos', 'POST', { text });
    const settings = await json(daemon, '/api/personal/settings');
    const thread = await json(daemon, '/api/threads', 'POST', { agent: 'pi', cwd: settings.directory });
    await json(daemon, `/api/threads/${thread.id}/turns`, 'POST', { text: 'personal-ui' });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
    await openUi(page, daemon); await openDesk(page);
    await page.locator('#desk-stack-inbox').waitFor();
    await page.locator('.desk-chart-day').first().tap();
    await page.locator('.desk-chart-tip').waitFor();
    await page.locator('#desk-stack-inbox').click();
    const accept = page.locator('.desk-card', { hasText: '预约护照续签' });
    const dismiss = page.locator('.desk-card', { hasText: '查收快递' });
    await accept.getByRole('button', { name: '跟踪', exact: true }).click();
    await accept.waitFor({ state: 'detached' });
    await dismiss.getByRole('button', { name: '不是我的事', exact: true }).click();
    await page.getByText('新发现都看过了。', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.desk-spread').waitFor({ state: 'detached' });
    const todos = await json(daemon, '/api/todos');
    assert.equal(todos.find(todo => todo.text === '预约护照续签').proposed, false);
    assert.ok(!todos.some(todo => todo.text === '查收快递'));
    const todo = todos.find(todo => todo.text === '周五前交报销');
    await page.locator(`#desk-pile-${todo.id}`).click();
    await page.getByRole('button', { name: '交给 agent', exact: true }).click();
    await page.getByRole('menuitem', { name: '新开私人对话', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.desk-spread').count(), 1, 'Escape only closes the nested menu');
    await page.keyboard.press('Escape');
    await page.locator('.desk-spread').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  } finally { await browser.close(); await daemon.stop(); }
});
