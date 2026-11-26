// Screenshots of a warning from the agent program itself (Claude Code refusing its configured
// default model) shown as a quiet line above the answer, not as the answer (desktop 1440 and
// phone 390, light and dark). Run after `npm run build`:
//   node packages/e2e/agent-warning-shots.mjs [outdir]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { api, startDaemon, openUi, launchBrowser, repoRoot } from './harness.mjs';

const out = process.argv[2] ?? join(repoRoot, 'e2e', 'shots', 'agent-warning');
mkdirSync(out, { recursive: true });
const request = async (daemon, path, method = 'GET', body) => {
  const res = await api(daemon, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!res.ok) throw new Error(`${path} answered ${res.status}: ${await res.text()}`);
  return res.json();
};
const wait = async fn => {
  const end = Date.now() + 30_000;
  for (;;) { const value = await fn(); if (value) return value; if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 100)); }
};

const title = '模型警告';
const daemon = await startDaemon({ FAKE_CLAUDE_REFUSED_MODEL: 'auto/gemini-3.8-flash[1m]' });
const browser = await launchBrowser();
try {
  const thread = await request(daemon, '/api/threads', 'POST', { agent: 'claude', cwd: daemon.workdir, title });
  await request(daemon, `/api/threads/${thread.id}/turns`, 'POST', { text: 'continue' });
  await wait(async () => (await request(daemon, `/api/threads/${thread.id}`)).status === 'idle');
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
      await page.locator('.menu-btn').click();
      await page.locator('.drawer-open').waitFor({ timeout: 5000 });
      await page.waitForTimeout(500);
    }
    await page.locator('.sidebar .thread-item').filter({ has: page.locator('.thread-title', { hasText: title }) }).click();
    if (viewport.width < 800) {
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.sidebar')).visibility === 'hidden' && Math.abs(document.querySelector('.main').getBoundingClientRect().x) < 1, null, { timeout: 5000 });
    }
    await page.locator('.agent-warning').waitFor({ timeout: 20_000 });
    await page.evaluate(s => document.documentElement.setAttribute('data-theme', s), scheme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(out, `${name}.png`), animations: 'disabled' });
    await page.close();
  }
  console.log('shots in', out);
} finally {
  await browser.close();
  await daemon.stop();
}
