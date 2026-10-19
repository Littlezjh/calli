import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../../e2e/harness.mjs';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const shots = fileURLToPath(new URL('../../e2e/shots/site/', import.meta.url));
let server, browser, base;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

before(async () => {
  await mkdir(shots, { recursive: true });
  // A plain static server: no daemon, credentials, agent processes or SPA fallback.
  server = createServer(async (req, res) => {
    try {
      let pathname = decodeURIComponent(new URL(req.url, 'http://test').pathname);
      if (pathname.startsWith('/nested/')) pathname = pathname.slice('/nested'.length);
      let file = resolve(root, '.' + pathname);
      if (file !== resolve(root) && !file.startsWith(root)) { res.writeHead(403).end(); return; }
      if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
      res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' });
      res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  if (server) await new Promise(r => server.close(r));
});

async function open({ phone = false, theme = 'light', path = '/', viewport, waitForDemo = true } = {}) {
  const context = await browser.newContext({ viewport: viewport ?? (phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }), isMobile: phone, hasTouch: phone, colorScheme: theme });
  await context.addInitScript(() => {
    localStorage.setItem('rah.token', 'test-existing-token');
    localStorage.setItem('rah.drafts', '{"new":{"text":"keep this draft","notes":[],"at":1}}');
    localStorage.setItem('rah.sidebar.activity', '1');
    localStorage.setItem('rah.sidebar.collapsed', '["keep"]');
  });
  const page = await context.newPage();
  const errors = [], calls = [], missing = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => { requests.push(req.url()); if (new URL(req.url()).pathname.includes('/api/')) calls.push(req.url()); });
  page.on('response', res => { if (res.status() >= 400) missing.push(res.url()); });
  await page.goto(base + path);
  if (waitForDemo && !path.includes('/demo/')) await page.locator('iframe.is-ready').waitFor({ timeout: 15_000 });
  return { page, context, demo: path.includes('/demo/') ? page : page.frameLocator('iframe'), errors, calls, missing, requests };
}

for (const phone of [false, true]) for (const theme of ['light', 'dark']) {
  test(`homepage and live walkthrough: ${phone ? 'phone' : 'desktop'}, ${theme}`, async () => {
    const { page, context, demo, errors, calls, missing } = await open({ phone, theme });
    try {
      await page.getByRole('button', { name: /发起一个任务/ }).click();
      await page.locator('iframe.is-ready').waitFor();
      await demo.getByRole('button', { name: '发送示例任务' }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const frame = page.frames().find(frame => frame.url().includes('/demo/'));
      assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: `${shots}/${phone ? 'phone' : 'desktop'}-${theme}.png`, fullPage: true });
      await page.getByRole('link', { name: '看看现有插件', exact: true }).click();
      await page.locator('#extensions').scrollIntoViewIfNeeded();
      assert.equal(await page.locator('.site-plugin').count(), 3);
      await page.getByRole('heading', { name: 'Memory 记忆看板', exact: true }).waitFor();
      assert.match(await page.locator('[data-plugin="loopx"]').innerText(), /当前接入只展示状态/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: `${shots}/${phone ? 'phone' : 'desktop'}-${theme}-extensions.png` });
      await page.locator('#contribute').scrollIntoViewIfNeeded();
      assert.match(await page.getByRole('link', { name: '贡献一个插件', exact: true }).getAttribute('href'), /docs\/contributing-extensions\.md$/);
      assert.match(await page.getByRole('link', { name: '提一个需求', exact: true }).getAttribute('href'), /\/issues\/new$/);
      await page.screenshot({ path: `${shots}/${phone ? 'phone' : 'desktop'}-${theme}-contribute.png` });
      await page.locator('#experience').scrollIntoViewIfNeeded();
      assert.equal(await demo.getByRole('button', { name: '计划', exact: true }).count(), 0);
      assert.equal(await demo.getByRole('button', { name: '定时任务', exact: true }).count(), 0);
      assert.equal(await demo.getByText('还没有分区。', { exact: true }).count(), 0);
      assert.equal(await demo.getByRole('button', { name: '按活动查看', exact: true, includeHidden: true }).getAttribute('aria-pressed'), 'false');
      await demo.getByRole('button', { name: '发送示例任务' }).click();
      assert.equal(await demo.getByLabel('预置任务', { exact: true }).inputValue(), '');
      await demo.getByRole('button', { name: '重新体验', exact: true }).waitFor({ timeout: 15_000 });
      await demo.getByText('已更改 2 个文件').waitFor();
      await page.locator('#experience').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${shots}/${phone ? 'phone' : 'desktop'}-${theme}-result.png` });
      assert.doesNotMatch(await demo.locator('.main').innerText(), /读取了\s*读取|编辑了\s*编辑/);
      assert.equal(await frame.evaluate(() => {
        const notice = document.querySelector('.main .showcase-notice').getBoundingClientRect();
        const scroller = document.querySelector('.main .scroller').getBoundingClientRect();
        return notice.bottom <= scroller.top + 1;
      }), true, 'the notice must not overlap the conversation');
      assert.equal(await page.evaluate(() => localStorage.getItem('rah.token')), 'test-existing-token');
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('rah.drafts')).new.text), 'keep this draft');
      assert.equal(await page.evaluate(() => localStorage.getItem('rah.sidebar.activity')), '1');
      assert.equal(await page.evaluate(() => localStorage.getItem('rah.sidebar.collapsed')), '["keep"]');
      assert.deepEqual(calls, []);
      assert.deepEqual(errors, []);
      assert.deepEqual(missing, []);
    } finally { await context.close(); }
  });
}

for (const phone of [false, true]) for (const theme of ['light', 'dark']) {
  test(`appearance menu switches both ways: ${phone ? 'phone' : 'desktop'}, ${theme}`, async () => {
    const { page, context, errors } = await open({ phone, theme });
    const activate = locator => phone ? locator.tap() : locator.click();
    const trigger = page.getByRole('button', { name: '选择外观', exact: true });
    try {
      await page.addStyleTag({ content: 'html { scroll-behavior: auto !important; }' });
      for (const [mode, label] of [['dark', '深色'], ['light', '浅色'], ['system', '跟随系统']]) {
        // A sticky header must not trap the mobile sheet, even after scrolling.
        await page.evaluate(y => scrollTo(0, y), mode === 'light' ? 500 : 0);
        await activate(trigger);
        const menu = page.getByRole('menu', { name: '选择外观', exact: true });
        await menu.waitFor();
        await page.waitForTimeout(250);
        const choices = await menu.getByRole('menuitemradio').evaluateAll(items => items.map(item => {
          const r = item.getBoundingClientRect();
          return {
            label: item.textContent,
            inside: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
            reachable: item.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)),
          };
        }));
        assert.equal(choices.length, 3);
        for (const choice of choices) {
          assert.ok(choice.inside && choice.reachable, `${choice.label} must be visible and reachable: ${JSON.stringify(choice)}`);
        }
        if (mode === 'dark') await page.screenshot({ path: `${shots}/${phone ? 'phone' : 'desktop'}-${theme}-appearance-menu.png` });
        await activate(menu.getByRole('menuitemradio', { name: label, exact: true }));
        await menu.waitFor({ state: 'detached' });
        const expected = mode === 'system' ? theme : mode;
        await page.waitForFunction(value => document.documentElement.dataset.theme === value && document.querySelector('iframe').contentDocument.documentElement.dataset.theme === value, expected);
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('limi.site.appearance')).mode), mode);
        if (mode === 'light') {
          await page.reload();
          await page.locator('iframe.is-ready').waitFor();
          assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
        }
      }
      await page.emulateMedia({ colorScheme: theme === 'light' ? 'dark' : 'light' });
      await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme === 'light' ? 'dark' : 'light');
      await activate(trigger);
      if (phone) await page.locator('.pop-scrim').tap({ position: { x: 5, y: 200 } });
      else await page.keyboard.press('Escape');
      await page.getByRole('menu', { name: '选择外观', exact: true }).waitFor({ state: 'detached' });
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

for (const phone of [false, true]) test(`approval, question, reset, install guidance and theme changes: ${phone ? 'phone' : 'desktop'}`, async () => {
  const { page, context, demo, errors, calls } = await open({ phone });
  try {
    await page.getByRole('button', { name: /处理一次审批/ }).click();
    await page.locator('iframe.is-ready').waitFor();
    await demo.getByRole('button', { name: '发送示例任务' }).click();
    await demo.getByRole('button', { name: '允许这一次', exact: true }).click({ timeout: 12_000 });
    await demo.getByRole('button', { name: '重新体验', exact: true }).waitFor();
    await demo.getByText('滚动位置保持稳定', { exact: false }).first().waitFor();

    await page.getByRole('button', { name: /一起讨论方案/ }).click();
    await page.locator('iframe.is-ready').waitFor();
    await demo.getByRole('button', { name: '发送示例任务' }).click();
    await demo.getByText('集中一张表', { exact: true }).click({ timeout: 12_000 });
    // The current single-choice sheet submits immediately on selection.
    await demo.getByRole('heading', { name: '迁移到集中声明的路由表' }).waitFor();
    await demo.getByRole('button', { name: '重新体验', exact: true }).click();
    await demo.getByRole('button', { name: '发送示例任务' }).waitFor();

    await page.getByRole('button', { name: '选择外观', exact: true }).click();
    await page.getByRole('menuitemradio', { name: '深色' }).click();
    await page.waitForFunction(() => document.querySelector('iframe').contentDocument.documentElement.dataset.theme === 'dark');
    await demo.getByRole('button', { name: '发送示例任务' }).waitFor();
    await demo.locator('.main').getByRole('button', { name: '开始使用', exact: true }).click();
    await demo.getByRole('button', { name: '查看安装步骤' }).click();
    await page.waitForFunction(() => document.getElementById('install').getBoundingClientRect().top < innerHeight);
    assert.equal(await demo.getByLabel('访问 token').count(), 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(calls, []);
  } finally { await context.close(); }
});

test('the offscreen walkthrough waits to load and keeps the site assets small', async () => {
  const { page, context, requests, errors, missing } = await open({ viewport: { width: 1440, height: 320 }, waitForDemo: false });
  try {
    await page.waitForTimeout(250);
    assert.equal(await page.locator('iframe').count(), 0);
    assert.equal(requests.some(url => /\/demo\/|\/assets\/demo-/.test(url)), false);
    assert.ok((await stat(resolve(root, 'limi-icon.png'))).size < 40_000);
    await assert.rejects(stat(resolve(root, 'manifest.webmanifest')), { code: 'ENOENT' });
    await page.getByRole('link', { name: '立即体验' }).click();
    await page.locator('iframe.is-ready').waitFor({ timeout: 15_000 });
    await page.frameLocator('iframe').getByRole('button', { name: '发送示例任务' }).waitFor();
    assert.deepEqual(errors, []);
    assert.deepEqual(missing, []);
  } finally { await context.close(); }
});

for (const phone of [false, true]) test(`scrolling past the conversation reaches the homepage: ${phone ? 'phone viewport' : 'desktop'}`, async () => {
  const { page, context, demo } = await open({ phone });
  try {
    await page.addStyleTag({ content: 'html { scroll-behavior: auto !important; }' });
    for (const state of ['ready', 'completed']) {
      if (state === 'completed') {
        await demo.getByRole('button', { name: '发送示例任务' }).click();
        await demo.getByRole('button', { name: '重新体验', exact: true }).waitFor({ timeout: 15_000 });
      }
      await page.evaluate(() => scrollBy(0, document.querySelector('.site-frame-area').getBoundingClientRect().top - 80));
      const box = await page.locator('.site-frame-area').boundingBox();
      const before = await page.evaluate(() => scrollY);
      await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.4);
      for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 300); await page.waitForTimeout(150); }
      await page.waitForFunction(y => scrollY > y + 50, before);
    }
  } finally { await context.close(); }
});

test('guided navigation avoids empty pages and links installation to remote access instructions', async () => {
  const { page, context, demo } = await open();
  try {
    await demo.getByRole('button', { name: '配置', exact: true }).click();
    assert.equal(await demo.getByRole('menuitem', { name: '已归档', exact: true }).count(), 0);
    assert.equal(await demo.getByRole('menuitem', { name: '概览', exact: true }).count(), 0);
    await demo.getByRole('menuitem', { name: '安装 Limi', exact: true }).click();
    await demo.getByRole('button', { name: '查看安装步骤' }).click();
    await page.locator('#install').getByText('http://127.0.0.1:8787/', { exact: true }).waitFor();
    assert.ok((await page.getByRole('link', { name: '远程访问说明' }).getAttribute('href')).endsWith('#远程访问'));
    assert.equal(await page.getByRole('link', { name: '在新页面体验' }).innerText(), '全屏体验');
  } finally { await context.close(); }
});

test('the site works under a static subdirectory and the demo can be opened on its own', async () => {
  for (const path of ['/nested/', '/nested/demo/?scene=approval&theme=dark']) {
    const { context, demo, errors, calls, missing } = await open({ path });
    try {
      await demo.getByRole('button', { name: '发送示例任务' }).waitFor();
      await demo.getByRole('button', { name: '发送示例任务' }).click();
      await demo.getByRole('button', { name: '停止演示' }).click();
      await demo.getByRole('button', { name: '重新体验', exact: true }).waitFor();
      assert.deepEqual(calls, []);
      assert.deepEqual(errors, []);
      assert.deepEqual(missing, []);
    } finally { await context.close(); }
  }
});

for (const phone of [false, true]) for (const theme of ['light', 'dark']) {
  test(`collaboration, board and memory examples: ${phone ? 'phone' : 'desktop'}, ${theme}`, async () => {
    const { page, context, demo, errors, calls, missing } = await open({ phone, theme });
    const prefix = `${shots}/${phone ? 'phone' : 'desktop'}-${theme}`;
    const example = name => page.locator('.site-demo-tabs').getByRole('button', { name, exact: false });
    try {
      await page.evaluate(() => localStorage.setItem('rah.ext.board.filters.v1', 'keep existing filters'));
      await demo.getByRole('heading', { name: '分头做事，一起交付。', exact: true }).waitFor();
      await page.locator('#collaboration').scrollIntoViewIfNeeded();
      await page.getByRole('heading', { name: '让不同 agent，一起把事做好。', exact: true }).waitFor();
      await page.screenshot({ path: `${prefix}-collaboration-feature.png` });
      await page.getByRole('button', { name: '体验一次协作', exact: true }).click();
      await page.locator('iframe.is-ready').waitFor();
      await demo.getByRole('button', { name: '发送示例任务' }).click();
      await demo.getByRole('button', { name: '查看智能体', exact: true }).first().click();
      await demo.getByRole('region', { name: '智能体面板' }).waitFor();
      assert.equal(await demo.locator('.agent-member').count(), 2);
      await page.locator('#experience').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${prefix}-collaboration.png` });
      await demo.locator('.agent-member').filter({ hasText: 'Codex 实现' }).click();
      await demo.locator('.agent-panel').getByText('实现设置页深色模式，覆盖跟随系统、手动切换与刷新后恢复。', { exact: true }).waitFor();
      await demo.getByRole('button', { name: '关闭智能体面板' }).click();
      await demo.getByRole('heading', { name: '协作结果', exact: true }).waitFor();
      await demo.getByRole('button', { name: '重新体验', exact: true }).waitFor();
      await page.screenshot({ path: `${prefix}-collaboration-result.png` });

      await example('体验看板').click();
      await page.locator('iframe.is-ready').waitFor();
      await demo.getByRole('heading', { name: '看板', exact: true }).waitFor();
      if (phone) await demo.getByRole('tab', { name: /待验收/ }).click();
      const done = demo.getByRole('checkbox', { name: '标记完成: 修复购物车数量显示', exact: true });
      await done.click();
      if (phone) await demo.getByRole('tab', { name: /已完成/ }).click();
      await demo.getByRole('checkbox', { name: '标记为未完成: 修复购物车数量显示', exact: true }).waitFor();
      await page.locator('#experience').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${prefix}-board.png` });
      await demo.locator('.ext-board-card').filter({ hasText: '修复购物车数量显示' }).click();
      await demo.getByText('示例测试通过，请检查手机布局后勾选完成。', { exact: true }).waitFor();

      await example('探索记忆').click();
      await page.locator('iframe.is-ready').waitFor();
      await demo.getByRole('searchbox', { name: '搜索标题与摘要…' }).fill('偏好');
      await demo.locator('.memory-card').filter({ hasText: '项目偏好' }).click();
      await demo.getByRole('button', { name: '原文', exact: true }).click();
      await demo.locator('.memory-original').getByText(/这是一条虚构记忆/).waitFor();
      await page.locator('#experience').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${prefix}-memory.png` });
      const frame = page.frames().find(frame => frame.url().includes('/demo/'));
      assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.evaluate(() => localStorage.getItem('rah.ext.board.filters.v1')), 'keep existing filters');
      assert.deepEqual(errors, []);
      assert.deepEqual(calls, []);
      assert.deepEqual(missing, []);
    } finally { await context.close(); }
  });
}
