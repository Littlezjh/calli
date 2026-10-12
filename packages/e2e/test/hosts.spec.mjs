// Other machines: adding one by what ssh calls it, switching to it, working there, and what the
// page says when it drops. The machines are directories and ssh is the fake one from the fixtures.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOnce, startDaemon, openUi, api, launchBrowser } from '../harness.mjs';

const SOCKET_IN_HOME = '.local/state/remote-agent-hub/daemon.sock';

let root;
let nodeSocket;
let node;
let hub;
let browser;
let page;

before(async () => {
  await buildOnce();
  root = mkdtempSync(join(tmpdir(), 'rah-e2e-hosts-'));
  const nodeHome = join(root, 'devbox');
  mkdirSync(nodeHome);
  nodeSocket = join(nodeHome, SOCKET_IN_HOME);
  node = await startDaemon({ RAH_SOCKET: nodeSocket, RAH_TERM_SHELL: '/bin/sh' });

  // The hub user's ssh config, and which of its names lead anywhere.
  const hubHome = join(root, 'hub-home');
  mkdirSync(join(hubHome, '.ssh'), { recursive: true });
  writeFileSync(join(hubHome, '.ssh', 'config'), 'Host devbox\n  HostName 192.0.2.10\nHost buildbox\n  HostName 192.0.2.11\nHost *\n  User me\n');
  const machines = join(root, 'machines.json');
  writeFileSync(machines, JSON.stringify({ devbox: { home: nodeHome }, buildbox: { fail: 'me@buildbox: Permission denied (publickey).' } }));
  hub = await startDaemon({ HOME: hubHome, RAH_SSH_BIN: 'fake-ssh', FAKE_SSH_HOSTS: machines });

  await api(node, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: node.workdir, title: '开发机上的线程' }) });
  await api(hub, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: hub.workdir, title: '本机的线程' }) });

  browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  page = await ctx.newPage();
});

after(async () => {
  await browser?.close();
  await hub?.stop();
  await node?.stop();
  rmSync(root, { recursive: true, force: true });
});

async function openMachines(p = page) {
  await p.getByRole('button', { name: '配置' }).click();
  await p.getByRole('menuitem', { name: '机器' }).click();
  return p.getByRole('dialog', { name: '机器' });
}

test('with no other machine, the list has no switcher', async () => {
  await openUi(page, hub);
  await page.getByText('本机的线程').waitFor({ timeout: 10_000 });
  assert.equal(await page.locator('.host-switch').count(), 0);
});

test('a machine is added by its name in the ssh config; one ssh cannot get into says why', async () => {
  const panel = await openMachines();
  // What the hub's ssh config names outright; the pattern is not a machine.
  await panel.getByRole('button', { name: '添加 buildbox' }).waitFor();
  assert.deepEqual(await panel.locator('.host-candidate .host-target').allInnerTexts(), ['devbox', 'buildbox']);

  await panel.getByRole('button', { name: '添加 buildbox' }).click();
  const failure = panel.getByRole('alert');
  await failure.waitFor();
  assert.match(await failure.innerText(), /没能添加 buildbox：hub 登录不上这台机器/);
  assert.match(await failure.innerText(), /Permission denied \(publickey\)/, "ssh's own words are there too");

  await panel.getByRole('button', { name: '添加 devbox' }).click();
  const row = panel.locator('.host-row', { hasText: 'devbox' });
  await row.getByText('在线').waitFor({ timeout: 15_000 });
  assert.equal(await failure.count(), 0, 'the earlier failure is cleared');
  assert.deepEqual(await panel.locator('.host-candidate .host-target').allInnerTexts(), ['buildbox'], 'no longer offered');
  await panel.getByRole('button', { name: '关闭' }).click();

  // Now there is a choice to make, so the list says which machine it is of.
  const tabs = page.getByRole('tablist', { name: '机器' }).getByRole('tab');
  assert.deepEqual(await tabs.allInnerTexts(), ['本机', 'devbox']);
  assert.equal(await tabs.nth(0).getAttribute('aria-selected'), 'true');
});

test('switching shows that machine, and a thread started there runs there', async () => {
  await page.getByRole('tab', { name: 'devbox' }).click();
  await page.locator('.sidebar .thread-title', { hasText: '开发机上的线程' }).waitFor({ timeout: 10_000 });
  assert.equal(await page.getByText('本机的线程').count(), 0);
  assert.equal(await page.getByRole('tab', { name: 'devbox' }).getAttribute('aria-selected'), 'true');

  // The draft is for a directory over there, and the agents are that machine's.
  await page.locator('.composer .context-btn').first().click();
  await page.getByRole('menuitemradio', { name: /^pi/ }).click();
  await page.locator('.composer textarea').click();
  await page.keyboard.type('hello from the hub');
  await page.keyboard.press('Enter');
  await page.getByText('hi there hello from the hub').waitFor({ timeout: 15_000 });
  assert.match(await page.locator('.topbar-sub').innerText(), /· devbox$/);

  const there = await (await api(node, '/api/threads')).json();
  assert.ok(there.some((t) => t.preview?.includes('hello from the hub') || t.title.includes('hello from the hub')), 'the thread is on the other machine');
  const here = await (await api(hub, '/api/threads')).json();
  assert.deepEqual(here.map((t) => t.title), ['本机的线程']);

  // The device remembers which machine it was looking at.
  await page.reload();
  await page.locator('.sidebar .thread-title', { hasText: '开发机上的线程' }).waitFor({ timeout: 10_000 });
  assert.equal(await page.getByRole('tab', { name: 'devbox' }).getAttribute('aria-selected'), 'true');

  await page.getByRole('tab', { name: '本机' }).click();
  await page.getByText('本机的线程').waitFor({ timeout: 10_000 });
  assert.equal(await page.locator('.sidebar .thread-title', { hasText: '开发机上的线程' }).count(), 0);
});

test('new drafts belong to their machine and survive switching and reloading', async () => {
  const composer = page.locator('.composer textarea');
  await composer.fill('只发给本机的草稿');
  await page.getByRole('tab', { name: 'devbox' }).click();
  await page.locator('.sidebar .thread-title', { hasText: '开发机上的线程' }).waitFor();
  assert.equal(await composer.inputValue(), '');
  await composer.fill('只发给开发机的草稿');
  await page.getByRole('tab', { name: '本机' }).click();
  await page.getByText('本机的线程').waitFor();
  assert.equal(await composer.inputValue(), '只发给本机的草稿');
  await page.reload();
  await page.getByText('本机的线程').waitFor();
  assert.equal(await composer.inputValue(), '只发给本机的草稿');
  await composer.fill('');
  await page.getByRole('tab', { name: 'devbox' }).click();
  await page.locator('.sidebar .thread-title', { hasText: '开发机上的线程' }).waitFor();
  assert.equal(await composer.inputValue(), '只发给开发机的草稿');
  await composer.fill('');
});

test('images sent through the hub are stored and displayed on the other machine', async () => {
  await page.locator('.thread-item', { hasText: '开发机上的线程' }).click();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
  await page.setInputFiles('.composer input[type=file]', { name: 'dot.png', mimeType: 'image/png', buffer: png });
  await page.locator('.composer textarea').fill('remote image');
  await page.locator('.composer textarea').press('Enter');
  await page.getByText('hi there remote image').waitFor({ timeout: 15_000 });
  const thread = (await (await api(node, '/api/threads')).json()).find((t) => t.title === '开发机上的线程');
  const events = await (await api(node, `/api/threads/${thread.id}/events`)).json();
  assert.ok(events.some((e) => e.type === 'turn.started' && e.data.images?.length === 1));
  const img = page.locator('.sent-images img').first();
  await img.waitFor();
  await page.waitForFunction(() => {
    const img = document.querySelector('.sent-images img');
    return img?.complete && img.naturalWidth > 0;
  });
});

test('a terminal opened through the hub runs in the other machine directory', async () => {
  await page.getByLabel('打开终端').click();
  await page.locator('.term-panel').waitFor();
  await page.locator('.term-body').click();
  await page.keyboard.type('pwd');
  await page.keyboard.press('Enter');
  await page.waitForFunction((cwd) => document.querySelector('.term-body')?.textContent?.includes(cwd), node.workdir);
  assert.equal((await (await api(node, '/api/terminals')).json()).length, 1);
  assert.equal((await (await api(hub, '/api/terminals')).json()).length, 0);
  await page.getByLabel('关闭', { exact: true }).click();
});

test('on a phone, switching machines stays on the thread list', async () => {
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
  try {
    await openUi(phone, hub);
    await phone.locator('.menu-btn').click();
    await phone.locator('.drawer-open').waitFor({ timeout: 5000 });
    await phone.getByRole('tab', { name: 'devbox' }).tap();
    await phone.getByText('开发机上的线程').waitFor({ timeout: 10_000 });
    assert.equal(await phone.locator('.drawer-open').count(), 1, 'still the list, now of the other machine');
  } finally {
    await phone.context().close();
  }
});

test('a machine that drops says so in place of its threads, and is back after a retry', async () => {
  await page.getByRole('tab', { name: 'devbox' }).click();
  await page.locator('.sidebar .thread-title', { hasText: '开发机上的线程' }).waitFor({ timeout: 10_000 });
  await node.stop();

  const down = page.locator('.host-down');
  await down.getByText('连不上 devbox').waitFor({ timeout: 30_000 });
  assert.match(await down.innerText(), /Agent Hub 没有应答/);
  assert.equal(await page.locator('.composer').count(), 0, 'nothing can be sent to a machine that is not there');
  assert.equal(await page.locator('.sidebar .thread-row').count(), 0, 'and its threads are not made to look gone');
  await page.getByText('这台机器现在连不上').waitFor();
  // The hub's own machine is still a click away.
  assert.equal(await page.getByRole('tab', { name: '本机' }).count(), 1);

  node = await startDaemon({ RAH_SOCKET: nodeSocket });
  await api(node, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: node.workdir, title: '回来以后的线程' }) });
  await down.getByRole('button', { name: '重试' }).click();
  await page.getByText('回来以后的线程').waitFor({ timeout: 20_000 });
  assert.equal(await page.locator('.host-down').count(), 0);
  assert.equal(await page.locator('.composer').count(), 1);
});

test('removing the machine on screen goes back to the hub, and the switcher goes with the last machine', async () => {
  const panel = await openMachines();
  await panel.locator('.host-row', { hasText: 'devbox' }).getByRole('button', { name: '移除' }).click();
  const confirm = page.getByRole('dialog', { name: '移除 devbox？' });
  await confirm.getByRole('button', { name: '移除' }).click();
  await panel.getByRole('button', { name: '添加 devbox' }).waitFor({ timeout: 10_000 });
  await panel.getByRole('button', { name: '关闭' }).click();
  await page.getByText('本机的线程').waitFor({ timeout: 10_000 });
  assert.equal(await page.locator('.host-switch').count(), 0);
  assert.deepEqual(await (await api(hub, '/api/hosts')).json(), []);
});
