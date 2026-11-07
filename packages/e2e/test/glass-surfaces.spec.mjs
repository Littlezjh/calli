import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { startDaemon, launchBrowser, openUi, api } from '../harness.mjs';

test('glass chrome has scrolling content behind it without hiding either end of the conversation', { timeout: 90000 }, async () => {
  const daemon = await startDaemon();
  const browser = await launchBrowser();
  const shots = '/tmp/calli-glass-surfaces'; mkdirSync(shots, { recursive: true });
  try {
    const thread = await (await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: daemon.workdir, title: '玻璃材质与页面导航' }) })).json();
    await api(daemon, `/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: Array.from({ length: 35 }, (_, i) => `### ${i + 1}. 统一菜单与配置体验\n\n配置采用完整页面，电脑分类与详情并排，手机逐层进入。滚动时观察顶部按钮与输入框后的内容。`).join('\n\n') }) });
    for (const mobile of [false, true]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, colorScheme: theme });
      const page = await context.newPage(); page.setDefaultTimeout(10000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await openUi(page, daemon);
      await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
      if (mobile) await page.getByRole('button', { name: '打开线程列表', exact: true }).click();
      await page.locator('.sidebar .thread-item', { hasText: thread.title }).click();
      await page.locator('.thread .markdown').first().waitFor();
      const scroller = page.locator('.main > .scroller');
      await page.waitForFunction(() => Number.parseFloat(document.querySelector('.main').style.getPropertyValue('--chat-bottom-overlap')) > 0);
      const measure = () => page.evaluate(() => {
        const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
        return { scroller: rect('.main > .scroller'), top: rect('.topbar'), input: rect('.composer-box'), thread: rect('.thread') };
      });
      let bounds = await measure();
      assert.ok(bounds.scroller.top <= bounds.top.top + 1, 'content scrolls behind the top controls');
      assert.ok(bounds.scroller.bottom >= bounds.input.bottom, 'content scrolls behind the input');
      await scroller.evaluate(el => { el.scrollTop = 0; });
      bounds = await measure();
      assert.ok(bounds.thread.top >= bounds.top.bottom, 'the first message starts below the header');
      await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
      bounds = await measure();
      assert.ok(bounds.thread.bottom <= bounds.input.top - 10, 'the last message remains above the input');
      await page.locator('.composer textarea').fill('多行输入\n检查输入框增高\n仍保留最后一条消息\n以及底部操作');
      await page.waitForTimeout(100);
      await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
      bounds = await measure();
      assert.ok(bounds.thread.bottom <= bounds.input.top - 10, 'composer growth updates the reading clearance');
      await page.locator('.composer textarea').fill('');
      await page.locator('.composer textarea').blur();
      await page.waitForTimeout(150); // the touch composer settles into its collapsed height
      await scroller.evaluate(el => { el.scrollTop = 600; });
      await page.screenshot({ path: `${shots}/chat-${mobile ? 'phone' : 'desktop'}-${theme}.png` });
      await page.locator('.topbar-more').click();
      await page.getByRole('menuitem', { name: '重命名', exact: true }).waitFor();
      await page.screenshot({ path: `${shots}/menu-${mobile ? 'phone' : 'desktop'}-${theme}.png` });
      await page.keyboard.press('Escape');
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
      assert.equal(await page.locator('.composer-box').evaluate(el => getComputedStyle(el).backdropFilter), 'none', 'reduced transparency keeps the opaque fallback');
      await cdp.detach();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); await daemon.stop(); }
});
