// Captures the new UI for eyeballing: desktop and phone, light and dark.
// Run: node shots.mjs (writes PNGs into shots/)
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOnce, startDaemon, openUi, api, launchBrowser } from './harness.mjs';

const outDir = join(process.cwd(), 'shots');
mkdirSync(outDir, { recursive: true });

await buildOnce();
const messagesFile = join(mkdtempSync(join(tmpdir(), 'rah-shots-')), 'messages.json');
const daemon = await startDaemon({ FAKE_PI_MESSAGES_FILE: messagesFile, RAH_E2E_DISCOVER_AGY2: '1' });
const browser = await launchBrowser();

// Arrange: a thread with a couple of turns, one from the terminal, plus a section.
const made = await (await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: daemon.workdir }) })).json();
await api(daemon, `/api/threads/${made.id}/turns`, { method: 'POST', body: JSON.stringify({ text: '把 TODO 里 P1 的几件事捋一下' }) });
let t1;
for (let i = 0; i < 50; i++) {
  t1 = await (await api(daemon, `/api/threads/${made.id}`)).json();
  if (t1.status !== 'running') break;
  await new Promise((r) => setTimeout(r, 100));
}
writeFileSync(
  messagesFile,
  JSON.stringify({
    [t1.agentSessionId]: [
      { role: 'user', content: '把 TODO 里 P1 的几件事捋一下' },
      { role: 'assistant', content: [{ type: 'text', text: '好，我按优先级过一遍，先看侧边栏，再看同步。' }] },
      { role: 'user', content: '先做分组头建会话' },
      { role: 'assistant', content: [{ type: 'text', text: '项目组和分区的"+"都加上了，新线程会直接带目录和分区。' }] },
    ],
  }),
);
await api(daemon, `/api/threads/${made.id}/sync`, { method: 'POST' });
await api(daemon, '/api/sections', { method: 'POST', body: JSON.stringify({ name: '支付重构' }) });

const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await openUi(page, daemon);
await page.locator('.thread-title').first().click();
await page.waitForTimeout(1500);
await page.evaluate(() => document.querySelector('[data-theme]') ?? document.documentElement.setAttribute('data-theme', 'light'));
for (const theme of ['light', 'dark']) {
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(outDir, `desktop-${theme}.png`) });
  // The draft composer with the section chip and the picker open.
  await page.locator('.new-thread').click();
  await page.locator('.composer .context-btn').first().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, `desktop-${theme}-picker.png`) });
  await page.keyboard.press('Escape');
}

const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
await openUi(phone, daemon);
await phone.locator('.menu-btn').click();
await phone.locator('.drawer-open').waitFor({ timeout: 5000 });
await phone.locator('.thread-title').first().click();
await phone.waitForTimeout(1200);
for (const theme of ['light', 'dark']) {
  await phone.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  await phone.waitForTimeout(300);
  await phone.screenshot({ path: join(outDir, `phone-${theme}.png`) });
}
// The thread list: a page of its own.
await phone.locator('.menu-btn').click();
await phone.locator('.drawer-open').waitFor({ timeout: 5000 });
await phone.waitForTimeout(500);
for (const theme of ['light', 'dark']) {
  await phone.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  await phone.waitForTimeout(300);
  await phone.screenshot({ path: join(outDir, `phone-${theme}-list.png`) });
}

await browser.close();
await daemon.stop();
rmSync(join(messagesFile, '..'), { recursive: true, force: true });
console.log('shots written to', outDir);
