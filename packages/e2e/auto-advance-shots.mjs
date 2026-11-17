// Screenshots of auto-advance (desktop 1440 and phone 390, light and dark): the quiet line under
// a thread's last turn ("waiting on X · checks again at HH:MM · Cancel" and "Auto-continue attempt
// 1/3 · HH:MM · Cancel"), and the switch in Settings → 自动交接. Run after `npm run build`:
//   node packages/e2e/auto-advance-shots.mjs [outdir]
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { api, startDaemon, openUi, launchBrowser, repoRoot } from './harness.mjs';

const out = process.argv[2] ?? join(repoRoot, 'e2e', 'shots', 'auto-advance');
mkdirSync(out, { recursive: true });
const markerDir = mkdtempSync(join(tmpdir(), 'calli-advance-shots-'));
const script = join(markerDir, 'advance-script');
const request = async (daemon, path, method = 'GET', body) => {
  const res = await api(daemon, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!res.ok) throw new Error(`${path} answered ${res.status}: ${await res.text()}`);
  return res.json();
};
const wait = async fn => {
  const end = Date.now() + 90_000;
  for (;;) { const value = await fn(); if (value) return value; if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 100)); }
};

// The fake agent scripts its replies from a file: the first thread waits on CI for 30 minutes (the
// line stays up for the shots), the second is unfinished work the hub will continue by itself —
// with the continue delay stretched out so the line holds still while shooting.
const daemon = await startDaemon(
  { CALLI_ADVANCE_CONTINUE_MS: '3600000' },
  { agents: [{ id: 'agy', adapter: 'agy', label: 'Agent 1', command: ['fake-agy'], env: { FAKE_AGY_ADVANCE: script } }] },
);
await request(daemon, '/api/advance/settings', 'PUT', { enabled: true });
// The board extension's `progress.report` grant is what makes agents end turns with a `[进度]`
// line; a fresh test hub has no extension installed, so install it with its manifest permissions.
const board = await request(daemon, '/api/extensions');
await request(daemon, '/api/extensions/board/install', 'POST', {
  granted: board.find(e => e.manifest.id === 'board')?.manifest.permissions,
});

const browser = await launchBrowser();
try {
  writeFileSync(script, 'wait:等 CI 跑完:30\n');
  const waiting = await request(daemon, '/api/threads', 'POST', { agent: 'agy', cwd: daemon.workdir, title: '等 CI 跑完' });
  await request(daemon, `/api/threads/${waiting.id}/turns`, 'POST', { text: '盯着 CI，好了继续' });
  await wait(async () => (await request(daemon, `/api/threads/${waiting.id}`)).advance?.nextAt != null);

  writeFileSync(script, 'doing:还在改收尾\n');
  const working = await request(daemon, '/api/threads', 'POST', { agent: 'agy', cwd: daemon.workdir, title: '收尾还在改' });
  await request(daemon, `/api/threads/${working.id}/turns`, 'POST', { text: '把收尾改完' });
  await wait(async () => (await request(daemon, `/api/threads/${working.id}`)).advance?.reason === 'continue');

  const openThread = async (page, id, phone) => {
    await page.locator('.sidebar .thread-item').filter({ has: page.locator('.thread-title', { hasText: id }) }).click();
    if (phone) {
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.sidebar')).visibility === 'hidden' && Math.abs(document.querySelector('.main').getBoundingClientRect().x) < 1, null, { timeout: 5000 });
    }
  };

  for (const [name, viewport, scheme] of [
    ['desktop-light', { width: 1440, height: 900 }, 'light'],
    ['desktop-dark', { width: 1440, height: 900 }, 'dark'],
    ['phone-light', { width: 390, height: 844 }, 'light'],
    ['phone-dark', { width: 390, height: 844 }, 'dark'],
  ]) {
    const page = await browser.newPage({ viewport, colorScheme: scheme });
    page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 300)); });
    await openUi(page, daemon);
    const phone = viewport.width < 800;
    if (phone) {
      await page.locator('.menu-btn').click();
      await page.locator('.drawer-open').waitFor({ timeout: 5000 });
      await page.waitForTimeout(500);
    }
    await openThread(page, '等 CI 跑完', phone);
    await page.locator('.advance-line').waitFor({ timeout: 20_000 });
    await page.locator('.advance-line').scrollIntoViewIfNeeded();
    await page.evaluate(s => document.documentElement.setAttribute('data-theme', s), scheme);
    await page.screenshot({ path: join(out, `wait-${name}.png`), animations: 'disabled' });

    // The continue line on the other thread, then the settings switch beside 自动交接.
    if (phone) {
      await page.locator('.menu-btn').click();
      await page.locator('.drawer-open').waitFor({ timeout: 5000 });
      await page.waitForTimeout(500);
    }
    await openThread(page, '收尾还在改', phone);
    await page.locator('.advance-line').waitFor({ timeout: 20_000 });
    await page.evaluate(s => document.documentElement.setAttribute('data-theme', s), scheme);
    await page.screenshot({ path: join(out, `continue-${name}.png`), animations: 'disabled' });

    await page.goto(daemon.base + '/#/settings/handover');
    await page.locator('.auto-setting-line', { hasText: '自动推进' }).waitFor({ timeout: 20_000 });
    await page.locator('.auto-setting-line', { hasText: '自动推进' }).scrollIntoViewIfNeeded();
    await page.evaluate(s => document.documentElement.setAttribute('data-theme', s), scheme);
    await page.screenshot({ path: join(out, `settings-${name}.png`), animations: 'disabled' });
    await page.close();
  }
  console.log(`shots in ${out}`);
} finally {
  await browser.close();
  await daemon.stop();
}
