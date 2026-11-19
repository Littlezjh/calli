// Screenshots of a chain read one segment to a page: the pill while the end of a page is pulled past,
// the page that follows, a short segment with room under it, and the dots at the side. Desktop 1440
// and phone 390, light and dark, with a real daemon and fake agents. Run after `npm run build`:
//   node packages/e2e/segment-pages-shots.mjs [outdir]
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, startDaemon, connect, launchBrowser, repoRoot } from './harness.mjs';

const out = process.argv[2] ?? join(repoRoot, 'e2e', 'shots', 'segment-pages');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'calli-pages-shots-'));
for (const id of ['agy', 'agy2', 'agy3']) writeFileSync(join(dir, `${id}.json`), JSON.stringify({ 'Gemini Models': 10, 'Claude Models': 20 }));
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
  const a = await request('/api/threads', 'POST', { agent: 'agy', model: 'gemini-pro', cwd: daemon.workdir, title: '修复登录接口的限流' });
  for (const text of ['先看看限流中间件现在怎么写的', '给登录接口加每分钟 5 次的限制', '补上超限时的 429 响应和 Retry-After', '写几条单元测试覆盖边界', '把配置项放进 settings 里', '再跑一遍整个测试集', '把 README 里的限流说明补全', '检查一下日志里有没有敏感信息']) await say(a.id, text);
  const b = await request(`/api/threads/${a.id}/takeover`, 'POST', { agent: 'agy2', model: 'gemini-pro', summary: 'source' });
  await idle(b.id);
  await say(b.id, '接着把压测脚本补上');
  const c = await request(`/api/threads/${b.id}/takeover`, 'POST', { agent: 'agy3', model: 'gemini-pro', summary: 'source' });
  await idle(c.id);
  for (const text of ['检查一下回归', '把文档里的限流说明更新', '再确认一次部署脚本']) await say(c.id, text);

  // A short segment: one message, then the hand over; read from the older conversation of a second chain.
  const s1 = await request('/api/threads', 'POST', { agent: 'agy', model: 'gemini-pro', cwd: daemon.workdir, title: '整理发布说明' });
  await say(s1.id, '把发布说明整理成三条');
  const s2 = await request(`/api/threads/${s1.id}/takeover`, 'POST', { agent: 'agy2', model: 'gemini-pro', summary: 'source' });
  await idle(s2.id);

  const open = async ([name, viewport, scheme], id) => {
    const phone = viewport.width < 800;
    const page = await browser.newPage({ viewport, colorScheme: scheme, hasTouch: phone, isMobile: phone });
    page.setDefaultTimeout(15_000);
    await page.goto(daemon.base + '/');
    await page.locator('.sidebar-inner').waitFor({ state: 'attached', timeout: 15_000 });
    if (await page.locator('.demo-bar').count()) await connect(page, daemon.token);
    const later = page.getByRole('button', { name: '稍后' });
    if (await later.count()) await later.click();
    await page.evaluate(s => document.documentElement.setAttribute('data-theme', s), scheme);
    await page.evaluate(h => { window.location.hash = h; }, `#/thread/${id}`);
    await page.locator('.scroller .row').first().waitFor();
    await page.waitForTimeout(700);
    const cdp = phone ? await page.context().newCDPSession(page) : null;
    return { name, page, phone, cdp };
  };
  const shot = (view, label) => view.page.screenshot({ path: join(out, `${label}-${view.name}.png`), animations: 'disabled' });
  const scroller = view => view.page.locator('.scroller').first();
  const toEdge = async (view, edge) => {
    await scroller(view).evaluate((el, e) => { el.scrollTop = e === 'top' ? 0 : el.scrollHeight; }, edge);
    await view.page.waitForTimeout(400);
  };
  const info = view => view.page.evaluate(() => ({
    title: document.querySelector('.topbar-title')?.textContent, sub: [...document.querySelectorAll('.topbar-sub')].map(e => e.textContent),
    line: document.querySelector('.chain-page [data-chain-line]')?.textContent, end: document.querySelector('[data-chain-end]')?.textContent,
    dots: document.querySelectorAll('.chain-rail-dot').length, mark: document.querySelector('.send-target')?.textContent,
  }));
  // Pull past an edge by `amount` and hold: a finger stays down, a wheel is still moving.
  const pull = async (view, dir, amount, hold = false) => {
    if (!view.phone) {
      await view.page.mouse.move(700, 450);
      const step = 20;
      for (let done = 0; done < amount; done += step) { await view.page.mouse.wheel(0, dir * step); await view.page.waitForTimeout(16); }
      return;
    }
    const x = 200, y0 = dir > 0 ? 600 : 300;
    await view.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
    for (let i = 1; i <= 12; i++) { await view.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 - dir * (amount / 0.6) * i / 12 }] }); await view.page.waitForTimeout(16); }
    if (!hold) await view.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const letGo = async view => {
    if (view.phone) await view.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await view.page.waitForTimeout(700);
  };

  for (const combo of combos) pages.push(await open(combo, c.id));
  for (const view of pages) {
    const n = view.name;
    console.log(n, 'latest', JSON.stringify(await info(view)));
    await toEdge(view, 'bottom');
    await shot(view, '1-latest-end');
    // Up to the top of the latest segment (its paging up reaches the true start first), then a short pull: it springs back.
    for (let i = 0; i < 12 && await view.page.locator('.older-messages').count(); i++) { await toEdge(view, 'top'); await view.page.locator('.older-messages').first().click().catch(() => undefined); await view.page.waitForTimeout(500); }
    await toEdge(view, 'top');
    await view.page.waitForTimeout(400);
    await shot(view, '2-latest-top');
    await pull(view, -1, view.phone ? 50 : 120, true);
    await shot(view, '3-pull-back-partial');
    await letGo(view);
    console.log(n, 'after short pull', JSON.stringify(await info(view)));
    await pull(view, -1, view.phone ? 130 : 300, true);
    await shot(view, '4-pull-back-full');
    await letGo(view);
    console.log(n, 'after full pull', JSON.stringify(await info(view)));
    await shot(view, '5-previous-segment-end');
    // The end of a middle segment pulled: toward the next one.
    await pull(view, 1, view.phone ? 50 : 120, true);
    await shot(view, '6-pull-next-partial');
    await letGo(view);
    await pull(view, 1, view.phone ? 130 : 300, true);
    await shot(view, '7-pull-next-full');
    await letGo(view);
    console.log(n, 'after pull next', JSON.stringify(await info(view)));
    await shot(view, '8-next-segment-start');
    if (!view.phone) {
      // The dots jump straight to the first segment: a long one, then the middle one is the short one.
      await view.page.locator('.chain-rail-dot').first().click();
      await view.page.waitForTimeout(700);
      console.log(n, 'rail first', JSON.stringify(await info(view)));
      await shot(view, '9-rail-first');
      await view.page.locator('.chain-rail-dot').nth(1).click();
      await view.page.waitForTimeout(700);
      await shot(view, '10-short-segment');
      await view.page.locator('.chain-end-next').focus();
      await shot(view, '11-next-button-focus');
      await view.page.locator('.chain-end-next').click();
      await view.page.waitForTimeout(700);
      console.log(n, 'next button', JSON.stringify(await info(view)));
    } else {
      // The short segment alone on a phone: back one page.
      await pull(view, -1, 130);
      await view.page.waitForTimeout(700);
      await shot(view, '10-short-segment');
    }
  }
  for (const view of pages) { await view.page.close(); }
  pages.length = 0;
  for (const combo of combos) {
    const view = await open(combo, s1.id);
    pages.push(view);
    await toEdge(view, 'bottom');
    console.log(view.name, 'short', JSON.stringify(await info(view)));
    await shot(view, '12-short-segment-whitespace');
  }
  console.log(`shots in ${out}`);
} finally {
  for (const view of pages) await view.page.close().catch(() => undefined);
  await browser.close();
  await daemon.stop();
}
