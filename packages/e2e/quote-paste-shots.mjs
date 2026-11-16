// Screenshots of a message copied as a quote in one thread and pasted into another's box (desktop
// 1440 and phone 390, light and dark): the paste lands as a quote above the input, not `> ` lines,
// and the sent message tells the agent where to read the original. Run after `npm run build`:
//   node packages/e2e/quote-paste-shots.mjs [outdir]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { api, startDaemon, openUi, launchBrowser, repoRoot } from './harness.mjs';

const out = process.argv[2] ?? join(repoRoot, 'e2e', 'shots', 'quote-paste');
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

const daemon = await startDaemon({}, { agents: [{ id: 'agy', adapter: 'agy', label: 'Agent 1', command: ['fake-agy'] }] });
const browser = await launchBrowser();
try {
  const a = await request(daemon, '/api/threads', 'POST', { agent: 'agy', cwd: daemon.workdir, title: '引用来源' });
  await request(daemon, `/api/threads/${a.id}/turns`, 'POST', { text: '列一下群聊章节的问题' });
  const b = await request(daemon, '/api/threads', 'POST', { agent: 'agy', cwd: daemon.workdir, title: '粘贴目标' });
  await request(daemon, `/api/threads/${b.id}/turns`, 'POST', { text: 'hello' });
  await wait(async () => (await request(daemon, `/api/threads/${a.id}`)).status === 'idle' && (await request(daemon, `/api/threads/${b.id}`)).status === 'idle');

  const pick = async (page, narrow, title) => {
    if (narrow) {
      await page.locator('.menu-btn').click();
      await page.locator('.drawer-open').waitFor({ timeout: 5000 });
      await page.waitForTimeout(500);
    }
    await page.locator('.sidebar .thread-item').filter({ has: page.locator('.thread-title', { hasText: title }) }).first().click();
    if (narrow) await page.waitForTimeout(600);
  };
  let first = true;
  for (const [name, viewport, scheme] of [
    ['desktop-light', { width: 1440, height: 900 }, 'light'],
    ['desktop-dark', { width: 1440, height: 900 }, 'dark'],
    ['phone-light', { width: 390, height: 844 }, 'light'],
    ['phone-dark', { width: 390, height: 844 }, 'dark'],
  ]) {
    const narrow = viewport.width < 800;
    const page = await browser.newPage({ viewport, colorScheme: scheme });
    page.on('pageerror', e => console.log('[pageerror]', e.message));
    await openUi(page, daemon);
    await page.evaluate(s => document.documentElement.setAttribute('data-theme', s), scheme);
    await pick(page, narrow, '引用来源');
    await page.getByRole('button', { name: '更多消息操作' }).last().click();
    await page.getByRole('menuitem', { name: '复制为引用' }).click();
    const copied = await page.evaluate(() => JSON.parse(localStorage.getItem('calli.copiedQuote')));
    await pick(page, narrow, '粘贴目标');
    const box = page.locator('.composer textarea').first();
    await box.click();
    // The copy itself went through the page's copy event; the paste carries what it put there.
    await box.evaluate((el, text) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, copied.text.trim().split('\n').map(l => `> ${l}`.trimEnd()).join('\n'));
    await page.locator('.note-strip').first().waitFor({ timeout: 5000 });
    const value = await box.inputValue();
    if (value) throw new Error(`the paste also went into the box: ${value}`);
    await page.screenshot({ path: join(out, `pasted-${name}.png`), animations: 'disabled' });
    if (first) {
      first = false;
      await box.fill('这些问题怎么改？');
      await box.press('Enter');
      const sent = await wait(async () => {
        const events = (await request(daemon, `/api/threads/${b.id}/events?since=0`)).events ?? [];
        return events.filter(e => e.type === 'turn.started').map(e => String(e.data.text)).find(t => t.includes('[注释 1]'));
      }).catch(async () => null);
      console.log('sent:', sent ? sent.split('\n').slice(0, 3).join(' | ') : '(not found via events api)');
      await page.waitForTimeout(1200);
      await page.screenshot({ path: join(out, `sent-${name}.png`), animations: 'disabled' });
    }
    await page.close();
  }
  console.log(`shots in ${out}`);
} finally {
  await browser.close();
  await daemon.stop();
}
