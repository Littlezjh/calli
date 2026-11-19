// Screenshots of a chain read one segment to a page: the pill while an edge is dragged past (a finger,
// or a mouse pressed on empty space), the page that follows, a short segment with room under it. Also
// checks that a wheel at an edge and a drag that starts on text never turn the page. Desktop 1440
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
  // Drag past an edge by `px` of finger or mouse movement and hold. Dragging up goes to the next segment, down to the earlier.
  const drag = async (view, dir, px, hold = false, from) => {
    const x = view.phone ? 200 : 380, y0 = from ?? (dir > 0 ? 600 : 300);
    const move = async y => view.phone
      ? view.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] })
      : view.page.mouse.move(x, y);
    if (view.phone) await view.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
    else { await view.page.mouse.move(x, y0); await view.page.mouse.down(); }
    for (let i = 1; i <= 14; i++) { await move(y0 - dir * px * i / 14); await view.page.waitForTimeout(16); }
    if (!hold) await letGo(view);
  };
  const letGo = async view => {
    if (view.phone) await view.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    else await view.page.mouse.up();
    await view.page.waitForTimeout(700);
  };
  // Which segment is on screen: the top bar names it (a segment's own line may load in later).
  const lineOf = view => view.page.evaluate(() => `${document.querySelector('.topbar-title')?.textContent}|${[...document.querySelectorAll('.topbar-sub')].map(e => e.textContent).join()}`);
  const check = (ok, what) => { if (!ok) throw new Error(`FAILED: ${what}`); console.log('ok:', what); };

  for (const combo of combos) pages.push(await open(combo, c.id));
  for (const view of pages) {
    const n = view.name;
    const latestLine = await lineOf(view);
    console.log(n, 'latest', JSON.stringify(await info(view)));
    // The page has no mark of its own at the end: no end line, no next button, no dots.
    check(await view.page.locator('[data-chain-end], .chain-end-next, .chain-rail').count() === 0, `${n}: no end line, next button or dots`);
    await toEdge(view, 'bottom');
    await shot(view, '1-latest-end');
    for (let i = 0; i < 12 && await view.page.locator('.older-messages').count(); i++) { await toEdge(view, 'top'); await view.page.locator('.older-messages').first().click().catch(() => undefined); await view.page.waitForTimeout(500); }
    await toEdge(view, 'top');
    await shot(view, '2-latest-top');
    // A wheel at the edge only stops there.
    await view.page.mouse.move(700, 450);
    if (!view.phone) { for (let i = 0; i < 40; i++) { await view.page.mouse.wheel(0, -120); await view.page.waitForTimeout(16); } await view.page.waitForTimeout(600); check(await lineOf(view) === latestLine, `${n}: a wheel past the top does not change segment`); await shot(view, '3-wheel-stays-at-top'); }
    // A mouse that starts on words selects them instead.
    if (!view.phone) {
      const box = await view.page.locator('.chain-page p').first().boundingBox();
      await view.page.mouse.move(box.x + 20, box.y + box.height / 2);
      await view.page.mouse.down();
      for (let i = 1; i <= 20; i++) { await view.page.mouse.move(box.x + 20 + i * 10, box.y + box.height / 2 + i * 20); await view.page.waitForTimeout(16); }
      check(await view.page.locator('.chain-pill.on').count() === 0, `${n}: a drag from text shows no pill`);
      await view.page.mouse.up();
      check(await lineOf(view) === latestLine, `${n}: a drag from text does not change segment`);
      await view.page.evaluate(() => getSelection()?.removeAllRanges());
    }
    // An unfinished drag springs back.
    await toEdge(view, 'top');
    await drag(view, -1, view.phone ? 160 : 170, true);
    await shot(view, '4-drag-back-partial');
    await letGo(view);
    check(await lineOf(view) === latestLine, `${n}: a short drag springs back`);
    // A full one, held: the pill says what lets go does.
    await drag(view, -1, view.phone ? 340 : 400, true);
    await shot(view, '5-drag-back-full');
    console.log(n, 'pill', JSON.stringify(await view.page.locator('.chain-pill.on').allInnerTexts()));
    await letGo(view);
    const earlier = await lineOf(view);
    check(earlier !== latestLine, `${n}: a full drag goes back a segment`);
    console.log(n, 'after full drag', JSON.stringify(await info(view)));
    await shot(view, '6-earlier-segment-end');
    if (!view.phone) {
      await view.page.mouse.move(700, 450);
      for (let i = 0; i < 40; i++) { await view.page.mouse.wheel(0, 120); await view.page.waitForTimeout(16); }
      await view.page.waitForTimeout(600);
      check(await lineOf(view) === earlier, `${n}: a wheel past the bottom does not change segment`);
    }
    await drag(view, 1, view.phone ? 160 : 170, true);
    await shot(view, '7-drag-next-partial');
    await letGo(view);
    await drag(view, 1, view.phone ? 340 : 400, true);
    await shot(view, '8-drag-next-full');
    await letGo(view);
    check(await lineOf(view) === latestLine, `${n}: a full drag the other way goes on to the next segment`);
    await shot(view, '9-next-segment-start');
  }
  for (const view of pages) { await view.page.close(); }
  pages.length = 0;
  for (const combo of combos) {
    const view = await open(combo, s1.id);
    pages.push(view);
    await toEdge(view, 'bottom');
    console.log(view.name, 'short', JSON.stringify(await info(view)));
    await shot(view, '10-short-segment-whitespace');
  }
  console.log(`shots in ${out}`);
} finally {
  for (const view of pages) await view.page.close().catch(() => undefined);
  await browser.close();
  await daemon.stop();
}
