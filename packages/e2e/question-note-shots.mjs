// Screenshot the question card with its optional note line on it, desktop and phone, light and dark.
// Run `npm run build` from the repository root before capturing.
// Run: node packages/e2e/question-note-shots.mjs   (writes packages/e2e/shots/question-note/)
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon, launchBrowser, api, openUi } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'shots', 'question-note');
mkdirSync(outDir, { recursive: true });

const daemon = await startDaemon();
const browser = await launchBrowser();
const created = await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'claude', title: '提问卡片', cwd: daemon.workdir, workMode: 'plan', permissionMode: 'ask' }) });
const thread = await created.json();
await api(daemon, `/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'plan-question' }) });

const shots = [
  ['desktop-light', { width: 1280, height: 900 }, 'light'],
  ['desktop-dark', { width: 1280, height: 900 }, 'dark'],
  ['mobile-light', { width: 390, height: 844 }, 'light'],
  ['mobile-dark', { width: 390, height: 844 }, 'dark'],
];

for (const [name, viewport, scheme] of shots) {
  const context = await browser.newContext({ viewport, colorScheme: scheme });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await openUi(page, daemon);
  if (viewport.width < 900) await page.locator('.menu-btn').click();
  await page.locator('.thread-row', { hasText: '提问卡片' }).click();
  const sheet = page.getByRole('dialog', { name: '智能体提问' });
  await sheet.waitFor();
  // The card as it arrives: the choice, its optional note line, and one submit.
  await page.screenshot({ path: join(outDir, `fresh-${name}.png`) });
  // The same card with an option picked and a note typed, still one card.
  await sheet.getByRole('radio', { name: /桌面和手机/ }).click();
  await sheet.getByPlaceholder('补充或自己的回答（可选）').fill('两边都要，手机优先');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(outDir, `filled-${name}.png`) });
  await context.close();
}

await browser.close();
await daemon.stop();
console.log(`wrote ${outDir}`);
