// Screenshots of the handover started from a message's More menu (desktop 1440 and phone 390,
// light and dark): the menu with 自动交接 last, the dialog with who takes over and who writes the
// summary, and the successor once another agent compressed the record. Run after `npm run build`:
//   node packages/e2e/takeover-shots.mjs [outdir]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { api, startDaemon, openUi, launchBrowser, repoRoot } from './harness.mjs';

const out = process.argv[2] ?? join(repoRoot, 'e2e', 'shots', 'takeover');
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

const daemon = await startDaemon({}, { agents: [
  { id: 'agy', adapter: 'agy', label: 'Agent 1', command: ['fake-agy'] },
  { id: 'agy2', adapter: 'agy', label: 'Agent 2', command: ['fake-agy'] },
] });
const browser = await launchBrowser();
try {
  const thread = await request(daemon, '/api/threads', 'POST', { agent: 'agy', cwd: daemon.workdir, title: '自动交接' });
  await request(daemon, `/api/threads/${thread.id}/turns`, 'POST', { text: '整理一下这篇文章的群聊章节' });
  await wait(async () => (await request(daemon, `/api/threads/${thread.id}`)).status === 'idle');

  const open = async (viewport, scheme) => {
    const page = await browser.newPage({ viewport, colorScheme: scheme });
    page.on('response', r => { if (r.status() >= 400) console.log('[http]', r.status(), new URL(r.url()).pathname); });
    await openUi(page, daemon);
    await page.evaluate(s => document.documentElement.setAttribute('data-theme', s), scheme);
    if (viewport.width < 800) {
      await page.locator('.menu-btn').click();
      await page.locator('.drawer-open').waitFor({ timeout: 5000 });
      await page.waitForTimeout(500);
    }
    await page.locator('.sidebar .thread-item').filter({ has: page.locator('.thread-title', { hasText: '自动交接' }) }).first().click();
    if (viewport.width < 800) await page.waitForTimeout(600);
    return page;
  };
  for (const [name, viewport, scheme] of [
    ['desktop-light', { width: 1440, height: 900 }, 'light'],
    ['desktop-dark', { width: 1440, height: 900 }, 'dark'],
    ['phone-light', { width: 390, height: 844 }, 'light'],
    ['phone-dark', { width: 390, height: 844 }, 'dark'],
  ]) {
    const page = await open(viewport, scheme);
    const more = page.getByRole('button', { name: '更多消息操作' }).last();
    await more.waitFor({ timeout: 10_000 });
    await more.click();
    const item = page.getByRole('menuitem', { name: '自动交接' });
    await item.waitFor({ timeout: 5000 });
    await page.screenshot({ path: join(out, `menu-${name}.png`), animations: 'disabled' });
    await item.click();
    await page.locator('#takeover-title').waitFor({ timeout: 5000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(out, `dialog-source-${name}.png`), animations: 'disabled' });
    await page.getByRole('radio', { name: '其他智能体写' }).click();
    await page.screenshot({ path: join(out, `dialog-other-${name}.png`), animations: 'disabled' });
    await page.close();
  }

  // Hand it over for real: Agent 2 takes over, Agent 2 compresses the record.
  const page = await open({ width: 1440, height: 900 }, 'light');
  await page.getByRole('button', { name: '更多消息操作' }).last().click();
  await page.getByRole('menuitem', { name: '自动交接' }).click();
  await page.getByRole('radio', { name: '其他智能体写' }).click();
  await page.getByRole('button', { name: '开始交接' }).click();
  await page.locator('#takeover-title').waitFor({ state: 'detached', timeout: 30_000 });
  const next = await wait(async () => (await request(daemon, '/api/threads')).threads?.find(t => t.handover?.sourceId === thread.id)
    ?? (await request(daemon, '/api/threads')).find?.(t => t.handover?.sourceId === thread.id));
  console.log('successor', next.agent, next.handover?.mode);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(out, 'after-desktop-light.png'), animations: 'disabled' });
  await page.close();
  console.log(`shots in ${out}`);
} finally {
  await browser.close();
  await daemon.stop();
}
