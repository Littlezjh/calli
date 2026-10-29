// Every machine's threads in one list: named by machine, opened where they are, kept across
// reloads, and a machine that drops out says so instead of its threads silently going away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon, openUi, api, launchBrowser } from '../harness.mjs';

const SOCKET_IN_HOME = '.local/state/calli/daemon.sock';

test('the merged list shows every machine, opens a thread on its own machine, and says when one is gone', { timeout: 240000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'calli-e2e-merged-'));
  const nodeHome = join(root, 'devbox');
  mkdirSync(nodeHome);
  const node = await startDaemon({ CALLI_SOCKET: join(nodeHome, SOCKET_IN_HOME) });
  const hubHome = join(root, 'hub-home');
  mkdirSync(join(hubHome, '.ssh'), { recursive: true });
  writeFileSync(join(hubHome, '.ssh', 'config'), 'Host devbox\n  HostName 192.0.2.10\n');
  const machines = join(root, 'machines.json');
  writeFileSync(machines, JSON.stringify({ devbox: { home: nodeHome } }));
  const hub = await startDaemon({ HOME: hubHome, CALLI_SSH_BIN: 'fake-ssh', FAKE_SSH_HOSTS: machines });
  const shots = process.env.CALLI_E2E_SHOTS_DIR;
  if (shots) mkdirSync(shots, { recursive: true });
  let browser;
  let nodeUp = true;
  try {
    await (await api(node, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: node.workdir, title: '开发机上的线程' }) })).json();
    await api(hub, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: hub.workdir, title: '本机的线程' }) });
    assert.equal((await api(hub, '/api/hosts', { method: 'POST', body: JSON.stringify({ target: 'devbox' }) })).ok, true);
    const devboxId = (await (await api(hub, '/api/hosts')).json())[0].id;
    browser = await launchBrowser();
    const open = async (mobile, colorScheme) => {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, colorScheme });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      await openUi(page, hub);
      if (mobile) await page.locator('.menu-btn').click();
      return { context, page, errors };
    };
    const row = (page, title) => page.locator('.sidebar .thread-row', { has: page.locator('.thread-title', { hasText: new RegExp(`^${title}$`) }) });

    for (const mobile of [false, true]) for (const colorScheme of ['light', 'dark']) {
      const { context, page, errors } = await open(mobile, colorScheme);
      try {
        await row(page, '本机的线程').waitFor({ timeout: 10_000 });
        const all = page.getByRole('tab', { name: '全部' });
        await all.click();
        assert.equal(await all.getAttribute('aria-selected'), 'true');
        await row(page, '开发机上的线程').waitFor({ timeout: 10_000 });
        await row(page, '本机的线程').waitFor();
        // Threads elsewhere are named by their machine; the hub's own are not.
        assert.match(await row(page, '开发机上的线程').locator('.thread-dir').innerText(), /^devbox · /);
        assert.doesNotMatch(await row(page, '本机的线程').locator('.thread-dir').innerText(), /·/);
        assert.equal(await row(page, '开发机上的线程').locator('.row-more').count(), 0, 'no menu acting on the wrong machine');
        if (shots) await page.screenshot({ path: join(shots, `merged-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`), animations: 'disabled' });

        // Opening a thread elsewhere goes to that machine, the list still merged.
        await row(page, '开发机上的线程').locator('.thread-item').click();
        await page.locator('.topbar-sub').filter({ hasText: /devbox/ }).waitFor({ timeout: 15_000 });
        assert.equal(await page.evaluate(() => localStorage.getItem('calli.host')), devboxId, 'the page is on devbox now');
        if (mobile) await page.locator('.menu-btn').click();
        await page.getByRole('tab', { name: '全部', selected: true }).waitFor();
        assert.equal(await row(page, '开发机上的线程').locator('.row-more').count(), 1, 'on its own machine the thread has its menu again');
        await row(page, '本机的线程').waitFor();

        // A reload keeps the merged list.
        await page.reload();
        if (mobile) await page.locator('.menu-btn').click();
        await page.getByRole('tab', { name: '全部', selected: true }).waitFor({ timeout: 10_000 });
        await row(page, '本机的线程').waitFor({ timeout: 10_000 });

        // Picking one machine leaves the merged list.
        await page.getByRole('tab', { name: '本机' }).click();
        if (mobile && !(await page.locator('.sidebar .thread-row').first().isVisible())) await page.locator('.menu-btn').click();
        await row(page, '本机的线程').waitFor({ timeout: 10_000 });
        assert.equal(await row(page, '开发机上的线程').count(), 0);
        assert.deepEqual(errors, []);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
      } finally { await context.close(); }
    }

    // devbox goes away: its threads stay listed from the last read, and the list says so.
    await node.stop();
    nodeUp = false;
    for (const mobile of [false, true]) {
      const { context, page } = await open(mobile, 'light');
      try {
        await page.getByRole('tab', { name: '全部' }).click();
        const note = page.locator('.merged-note');
        await note.filter({ hasText: /devbox (连不上|读取失败)/ }).waitFor({ timeout: 60_000 });
        await row(page, '本机的线程').waitFor();
        if (shots) await page.screenshot({ path: join(shots, `merged-down-${mobile ? 'phone' : 'desktop'}-light.png`), animations: 'disabled' });
      } finally { await context.close(); }
    }
  } finally {
    await browser?.close();
    await hub.stop();
    if (nodeUp) await node.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
