// Screenshots of "new thread here" from a thread in a git worktree: the draft keeps the project in the
// picker and names the worktree in a chip, and the thread it starts shares that worktree (desktop
// 1440 and phone 390, light and dark). Run after `npm run build`:
//   node packages/e2e/new-beside-shots.mjs [outdir]
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, startDaemon, openUi, launchBrowser, repoRoot } from './harness.mjs';

const out = process.argv[2] ?? join(repoRoot, 'e2e', 'shots', 'new-beside');
mkdirSync(out, { recursive: true });
const request = async (daemon, path, method = 'GET', body) => {
  const res = await api(daemon, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!res.ok) throw new Error(`${path} answered ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
};
const wait = async fn => {
  const end = Date.now() + 30_000;
  for (;;) { const value = await fn(); if (value) return value; if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 100)); }
};
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args], { cwd });

const title = '整理侧栏';
const daemon = await startDaemon();
const repo = join(daemon.workdir, 'my-app');
mkdirSync(repo, { recursive: true });
git(repo, 'init', '--quiet', '--initial-branch=main');
writeFileSync(join(repo, 'README.md'), '# my-app\n');
git(repo, 'add', '.');
git(repo, 'commit', '--quiet', '-m', 'first');
const browser = await launchBrowser();
try {
  const source = await request(daemon, '/api/threads', 'POST', { agent: 'claude', cwd: repo, title, worktree: true });
  await request(daemon, `/api/threads/${source.id}/turns`, 'POST', { text: 'hello' });
  await wait(async () => (await request(daemon, `/api/threads/${source.id}`)).status === 'idle');
  let sent = false;
  for (const [name, viewport, scheme] of [
    ['desktop-light', { width: 1440, height: 900 }, 'light'],
    ['desktop-dark', { width: 1440, height: 900 }, 'dark'],
    ['phone-light', { width: 390, height: 844 }, 'light'],
    ['phone-dark', { width: 390, height: 844 }, 'dark'],
  ]) {
    const page = await browser.newPage({ viewport, colorScheme: scheme });
    page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 300)); });
    await openUi(page, daemon);
    await page.evaluate(s => document.documentElement.setAttribute('data-theme', s), scheme);
    if (viewport.width < 800) {
      await page.locator('.menu-btn').click();
      await page.locator('.drawer-open').waitFor({ timeout: 5000 });
      await page.waitForTimeout(500);
    }
    await page.locator('.sidebar .thread-item').filter({ has: page.locator('.thread-title', { hasText: title }) }).first().click();
    await page.waitForTimeout(600);
    await page.locator('.topbar-more').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(out, `${name}-menu.png`), animations: 'disabled' });
    await page.getByRole('menuitem', { name: '在此目录新建线程' }).click();
    const chip = page.locator('.context-chip', { hasText: source.worktree.branch });
    await chip.waitFor({ timeout: 5000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(out, `${name}-draft.png`), animations: 'disabled' });
    if (!sent) {
      sent = true;
      await page.locator('textarea').first().fill('看看 README');
      await page.keyboard.press('Enter');
      const made = await wait(async () => (await request(daemon, '/api/threads')).find(t => t.id !== source.id && t.title !== title));
      if (made.cwd !== source.cwd || JSON.stringify(made.worktree) !== JSON.stringify(source.worktree)) throw new Error(`new thread not beside: ${JSON.stringify(made)}`);
      console.log('new thread shares the worktree:', made.cwd);
    } else {
      // Leaving the worktree returns the draft to the project.
      await chip.click();
      await chip.waitFor({ state: 'detached', timeout: 5000 });
      await page.screenshot({ path: join(out, `${name}-left.png`), animations: 'disabled' });
    }
    await page.close();
  }
  console.log('shots in', out);
} finally {
  await browser.close();
  await daemon.stop();
}
