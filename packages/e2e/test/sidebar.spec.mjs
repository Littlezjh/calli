// New threads straight from a sidebar group: a project's "+" pre-fills the directory, a
// section's "+" files the new thread into that section right away.
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
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  page = await ctx.newPage();
});

after(async () => {
  await browser?.close();
  await daemon?.stop();
});

async function pickPi() {
  await page.locator('.composer .context-btn').first().click();
  await page.getByRole('menuitemradio', { name: /^pi/ }).click();
}

async function sendMessage(text) {
  await page.locator('.composer textarea').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

test("the project group's + starts a thread with that directory pre-filled", async () => {
  await openUi(page, daemon);
  // A group only exists once a thread runs there; make one over the API.
  await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: daemon.workdir }) });
  await page.reload();
  await page.locator('.sidebar').getByRole('button', { name: '新线程', exact: true }).waitFor({ timeout: 10_000 });
  await pickPi();
  const name = (await page.locator('.group-name').first().innerText()).trim();
  await page.locator('.thread-group .group-add').first().hover();
  await page.locator('.thread-group .group-add').first().click();
  // The draft composer names the directory the thread will run in.
  await page.getByText('我们应该在', { exact: false }).waitFor();
  const header = await page.locator('.composer .context-btn').nth(1).innerText();
  assert.ok(header.includes(name), `expected ${name} in ${header}`);

  await sendMessage('hello');
  await page.getByText('hi there hello').waitFor({ timeout: 15_000 });
  // The thread is listed under its project.
  assert.ok(await page.locator('.thread-group', { hasText: 'hello' }).count());

  // The row says which agent runs it with the agent's mark; the name is what a screen reader hears.
  const row = page.locator('.thread-row', { hasText: 'hello' });
  assert.equal(await row.getByRole('img', { name: 'pi', exact: true }).locator('svg path').count(), 1);
  assert.equal(await row.locator('.agent-tag').count(), 0, 'one pi here, so the mark is enough');
});

test("the section group's + files the new thread into the section", async () => {
  const section = await (await api(daemon, '/api/sections', { method: 'POST', body: JSON.stringify({ name: '支付重构' }) })).json();
  await page.reload();
  await page.locator('.sidebar').getByRole('button', { name: '新线程', exact: true }).waitFor({ timeout: 10_000 });
  await pickPi();

  const group = page.locator('.thread-group', { hasText: '支付重构' });
  await group.locator('.group-add').click();
  // The draft says where the thread will be filed, and can be undone with a click.
  await page.locator('.context-chip').waitFor();
  assert.match(await page.locator('.context-chip').innerText(), /支付重构/);

  await sendMessage('a section thread');
  await page.getByText('hi there a section thread').waitFor({ timeout: 15_000 });

  // The thread now lives under the section, not under the project.
  const filed = page.locator('.thread-group', { hasText: '支付重构' }).locator('.thread-title', { hasText: 'a section thread' });
  await filed.waitFor({ timeout: 10_000 });
  const threads = await (await api(daemon, '/api/threads')).json();
  assert.equal(threads.find((t) => t.title === 'a section thread').sectionId, section.id);
});

test('search sits behind a button, and Escape puts it away', async () => {
  const list = page.locator('.sidebar');
  assert.equal(await list.getByLabel('搜索线程').evaluate((el) => el.tagName), 'BUTTON');
  await list.getByRole('button', { name: '搜索线程' }).click();
  // The field takes the focus, so typing can start at once.
  await page.keyboard.type('section');
  await list.locator('.thread-title', { hasText: 'a section thread' }).waitFor();
  assert.equal(await list.locator('.thread-title', { hasText: 'hello' }).count(), 0, 'only matches are listed');

  await page.keyboard.press('Escape');
  await list.locator('.thread-title', { hasText: 'hello' }).waitFor();
  assert.equal(await list.locator('.brand').isVisible(), true, 'the name is back where the field was');
});

test('the settings button holds what is not an everyday thing, and signing out asks first', async () => {
  const list = page.locator('.sidebar');
  for (const name of ['计划', '新线程', '搜索线程', '配置']) {
    assert.equal(await list.getByRole('button', { name, exact: true }).isVisible(), true, name);
  }
  assert.equal(await list.getByRole('button', { name: '已归档', exact: true }).count(), 0);

  const gear = list.getByRole('button', { name: '配置', exact: true });
  await gear.click();
  for (const name of ['外观', '已归档', '导入历史', '退出']) {
    await page.getByRole('menuitem', { name, exact: true }).waitFor({ timeout: 5_000 });
  }
  // The button is at the bottom of the screen, so the menu grows upwards from it and stays whole.
  const menu = await page.getByRole('menu', { name: '配置' }).boundingBox();
  const button = await gear.boundingBox();
  assert.ok(menu.y + menu.height <= button.y + 1, `the menu sits above its button (${menu.y + menu.height} vs ${button.y})`);
  assert.ok(menu.y >= 0 && menu.x >= 0);

  await page.getByRole('menuitem', { name: '退出', exact: true }).click();
  await page.getByText('退出登录？').waitFor({ timeout: 5_000 });
  await page.getByRole('button', { name: '取消' }).click();
  await page.getByText('退出登录？').waitFor({ state: 'detached', timeout: 5_000 });
  assert.equal(await list.locator('.brand').isVisible(), true, 'still signed in');
});

test('an open thread names its agent and directory in the top bar, not on the composer', async () => {
  await page.locator('.sidebar .thread-title', { hasText: 'hello' }).click();
  await page.getByText('hi there hello').waitFor({ timeout: 15_000 });
  const sub = page.locator('.topbar-sub');
  assert.equal(await sub.isVisible(), true);
  assert.match(await sub.innerText(), /^pi · /);
  assert.equal(await page.locator('.composer-context').count(), 0, 'the strip is only for choosing, before the thread exists');

  await page.locator('.sidebar').getByRole('button', { name: '新线程', exact: true }).click();
  await page.locator('.composer-context .context-btn').first().waitFor();
});
