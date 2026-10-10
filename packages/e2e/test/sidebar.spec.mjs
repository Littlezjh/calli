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
  await page.locator('.new-thread').waitFor({ timeout: 10_000 });
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
});

test("the section group's + files the new thread into the section", async () => {
  const section = await (await api(daemon, '/api/sections', { method: 'POST', body: JSON.stringify({ name: '支付重构' }) })).json();
  await page.reload();
  await page.locator('.new-thread').waitFor({ timeout: 10_000 });
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
