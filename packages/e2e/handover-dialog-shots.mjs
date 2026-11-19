// The manual handover dialog of a chain whose earlier conversation could take the work back: a new
// conversation by default with the older one a quiet line below, then the older one chosen.
// Desktop 1440 and phone 390, light and dark, a real daemon and fake agents. Run after `npm run build`:
//   node packages/e2e/handover-dialog-shots.mjs [outdir]
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, startDaemon, connect, launchBrowser, repoRoot } from './harness.mjs';

const out = process.argv[2] ?? join(repoRoot, 'e2e', 'shots', 'handover-dialog');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'calli-return-shots-'));
const quota = (agent, gemini = 10) => writeFileSync(join(dir, `${agent}.json`), JSON.stringify({ 'Gemini Models': gemini, 'Claude Models': 20 }));
for (const id of ['agy', 'agy2', 'agy3']) quota(id);
const daemon = await startDaemon({ CALLI_AGENTS_JSON: JSON.stringify({ agents: ['agy', 'agy2', 'agy3'].map((id, i) => ({
  id, adapter: 'agy', label: ['Claude Code', 'Codex', 'Gemini'][i], command: ['fake-agy'], env: { FAKE_HANDOVER_QUOTA: join(dir, `${id}.json`) },
})) }) });
const request = async (path, method = 'GET', body) => {
  const res = await api(daemon, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!res.ok) throw new Error(`${path} answered ${res.status}: ${await res.text()}`);
  return res.json();
};
const wait = async (fn, ms = 30_000) => {
  const end = Date.now() + ms;
  for (;;) { const value = await fn(); if (value) return value; if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 100)); }
};
const idle = id => wait(async () => { const t = await request(`/api/threads/${id}`); return t.status !== 'running' && !['checking', 'preparing', 'countdown'].includes(t.autoHandover?.state) && !t.queued.length && t; });
const say = async (id, text) => { await request(`/api/threads/${id}/turns`, 'POST', { text }); await idle(id); };

const combos = [
  ['desktop-light', { width: 1440, height: 900 }, 'light'],
  ['desktop-dark', { width: 1440, height: 900 }, 'dark'],
  ['phone-light', { width: 390, height: 844 }, 'light'],
  ['phone-dark', { width: 390, height: 844 }, 'dark'],
];
const browser = await launchBrowser();
const pages = [];
try {
  await request('/api/handover-settings', 'PUT', { enabled: true, threshold: 90, orders: { agy2: [{ agent: 'agy3', model: 'gemini-pro' }] }, method: 'summary' });
  const a = await request('/api/threads', 'POST', { agent: 'agy', model: 'gemini-pro', cwd: daemon.workdir, title: '修复登录接口的限流' });
  for (const text of ['先看看限流中间件现在怎么写的', '给登录接口加每分钟 5 次的限制', '补上超限时的 429 响应和 Retry-After', '写几条单元测试覆盖边界', '把配置项放进 settings 里', '再跑一遍整个测试集']) await say(a.id, text);
  // The first account is used up: the work goes to a second one, which carries on.
  const b = await request(`/api/threads/${a.id}/takeover`, 'POST', { agent: 'agy2', model: 'gemini-pro', summary: 'source' });
  await idle(b.id);
  for (const text of ['接着把压测脚本补上', '检查一下回归', '把文档里的限流说明更新']) await say(b.id, text);
  // The first one is used on its own meanwhile: two follow-ups the chain's reading leaves out.
  await say(a.id, '顺便把日志格式调整一下');
  await say(a.id, '日志里加上请求 id');

  const open = async (combo, id) => {
    const [name, viewport, scheme] = combo;
    const page = await browser.newPage({ viewport, colorScheme: scheme, hasTouch: viewport.width < 800, isMobile: viewport.width < 800 });
    page.setDefaultTimeout(15_000);
    await page.goto(daemon.base + '/');
    await page.locator('.sidebar-inner').waitFor({ state: 'attached', timeout: 15_000 });
    if (await page.locator('.demo-bar').count()) await connect(page, daemon.token);
    const later = page.getByRole('button', { name: '稍后' });
    if (await later.count()) await later.click();
    await page.evaluate(s => document.documentElement.setAttribute('data-theme', s), scheme);
    await page.evaluate(h => { window.location.hash = h; }, `#/thread/${id}`);
    await page.locator('.scroller .row').first().waitFor();
    await page.waitForTimeout(600);
    return { name, page, phone: viewport.width < 800 };
  };
  const shot = (view, label) => view.page.screenshot({ path: join(out, `${label}-${view.name}.png`), animations: 'disabled' });
  const scroller = view => view.page.locator('.scroller').first();
  const upTo = async (view, count) => {
    // Reading up loads the earlier segments one by one as the top comes into view.
    for (let i = 0; i < 30 && await view.page.locator('.chain-line').count() < count; i++) {
      await scroller(view).evaluate(el => { el.scrollTop = 0; });
      await view.page.waitForTimeout(350);
      // A page that already sits at the top gets no scroll event: the button is the same way in.
      const more = view.page.locator('.older-messages');
      if (await more.count()) { await more.first().click().catch(() => undefined); await view.page.waitForTimeout(500); }
    }
    await view.page.waitForTimeout(300);
  };
  // The manual handover dialog, with the older conversation offered.
  for (const combo of combos) {
    const view = await open(combo, b.id);
    await view.page.getByLabel('这个线程的更多操作').click();
    await view.page.getByRole('menuitem', { name: '分叉与交接', exact: true }).click();
    await view.page.getByRole('menuitem', { name: '交接', exact: true }).click().catch(async e => { await shot(view, 'debug-menu'); throw e; });
    // A new conversation is the default; the older one is a quiet line below the successor.
    const switchOld = view.page.getByRole('button', { name: /^或交回/ });
    await switchOld.waitFor();
    await view.page.waitForTimeout(500);
    await shot(view, 'manual-dialog');
    await switchOld.click();
    await view.page.getByRole('button', { name: '改为交到新对话' }).waitFor();
    await view.page.waitForTimeout(300);
    await shot(view, 'manual-dialog-old');
    await view.page.close();
  }

  console.log(`shots in ${out}`);
} finally {
  await browser.close();
  await daemon.stop();
}
