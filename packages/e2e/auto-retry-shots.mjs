// Screenshots of the automatic retry of a transient failure (desktop 1440 and phone 390, light
// and dark): the pink error card with the quiet "retries at …" line and its stop, then the
// timeline divider once the daemon resent the ask by itself. Run after `npm run build`:
//   node packages/e2e/auto-retry-shots.mjs [outdir]
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { api, startDaemon, openUi, launchBrowser, repoRoot } from './harness.mjs';

const out = process.argv[2] ?? join(repoRoot, 'e2e', 'shots', 'auto-retry');
mkdirSync(out, { recursive: true });
const markerDir = mkdtempSync(join(tmpdir(), 'calli-retry-shots-'));
const request = async (daemon, path, method = 'GET', body) => {
  const res = await api(daemon, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!res.ok) throw new Error(`${path} answered ${res.status}: ${await res.text()}`);
  return res.json();
};
const wait = async fn => {
  const end = Date.now() + 90_000;
  for (;;) { const value = await fn(); if (value) return value; if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 100)); }
};

// The fake agent fails the first "no-capacity" ask per conversation and answers the resend, so
// the watch arms, waits out its first spacing (a minute) and the thread goes on by itself.
const daemon = await startDaemon(
  { CALLI_RETRY_TICK_MS: '2000' },
  { agents: [{ id: 'agy', adapter: 'agy', label: 'Agent 1', command: ['fake-agy'], env: { FAKE_TRANSIENT_ONCE: join(markerDir, 'marker') } }] },
);

const browser = await launchBrowser();
try {
  const thread = await request(daemon, '/api/threads', 'POST', { agent: 'agy', cwd: daemon.workdir, title: '容量不足自动重试' });
  await request(daemon, `/api/threads/${thread.id}/turns`, 'POST', { text: 'no-capacity' });
  await wait(async () => (await request(daemon, `/api/threads/${thread.id}`)).autoRetry !== undefined
    && (await request(daemon, `/api/threads/${thread.id}`)).autoRetry !== null);

  const shoot = async (page, name, scheme) => {
    await page.locator('.error-box .error-retry').scrollIntoViewIfNeeded();
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: join(out, `armed-${name}.png`), animations: 'disabled' });
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
    if (viewport.width < 800) {
      // The phone keeps the list behind the menu button; open it and let the drawer settle.
      await page.locator('.menu-btn').click();
      await page.locator('.drawer-open').waitFor({ timeout: 5000 });
      await page.waitForTimeout(500);
    }
    await page.locator('.sidebar .thread-item').filter({ has: page.locator('.thread-title', { hasText: '容量不足自动重试' }) }).click();
    if (viewport.width < 800) {
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.sidebar')).visibility === 'hidden' && Math.abs(document.querySelector('.main').getBoundingClientRect().x) < 1, null, { timeout: 5000 });
    }
    await page.locator('.error-box .error-retry').waitFor({ timeout: 20_000 });
    await page.evaluate(s => document.documentElement.setAttribute('data-theme', s), scheme);
    await shoot(page, name, scheme);
    await page.close();
  }
  console.log('armed shots done');

  // Wait out the first spacing (60s), then the daemon resends, the marker lets it through and
  // the divider marks the turn the hub sent by itself. (The watch retires on its next due
  // check; the divider is on the timeline as soon as the thread is back on its feet.)
  await wait(async () => (await request(daemon, `/api/threads/${thread.id}`)).status === 'idle');
  for (const [name, viewport, scheme] of [
    ['desktop-light', { width: 1440, height: 900 }, 'light'],
    ['phone-dark', { width: 390, height: 844 }, 'dark'],
  ]) {
    const page = await browser.newPage({ viewport, colorScheme: scheme });
    await openUi(page, daemon);
    if (viewport.width < 800) {
      await page.locator('.menu-btn').click();
      await page.locator('.drawer-open').waitFor({ timeout: 5000 });
      await page.waitForTimeout(500);
    }
    await page.locator('.sidebar .thread-item').filter({ has: page.locator('.thread-title', { hasText: '容量不足自动重试' }) }).click();
    if (viewport.width < 800) {
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.sidebar')).visibility === 'hidden' && Math.abs(document.querySelector('.main').getBoundingClientRect().x) < 1, null, { timeout: 5000 });
    }
    await page.locator('.handover-divider').last().waitFor({ timeout: 20_000 });
    await page.locator('.handover-divider').last().scrollIntoViewIfNeeded();
    await page.evaluate(s => document.documentElement.setAttribute('data-theme', s), scheme);
    await page.screenshot({ path: join(out, `resumed-${name}.png`), animations: 'disabled' });
    await page.close();
  }
  console.log(`shots in ${out}`);
} finally {
  await browser.close();
  await daemon.stop();
}
