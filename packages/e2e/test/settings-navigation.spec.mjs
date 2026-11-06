import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { startDaemon, launchBrowser, openUi, api } from '../harness.mjs';

const navigate = (page, path) => page.evaluate(hash => { location.hash = hash; }, path);

test('settings pages preserve navigation, guard drafts and load details on entry across screen sizes and themes', async () => {
  const daemon = await startDaemon();
  const browser = await launchBrowser();
  const shots = '/tmp/calli-settings-navigation'; mkdirSync(shots, { recursive: true });
  try {
    const thread = await (await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: daemon.workdir, title: 'Navigation return' }) })).json();
    await api(daemon, `/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: Array.from({ length: 50 }, (_, i) => `Review paragraph ${i + 1}`).join('\n\n') }) });
    for (const mobile of [false, true]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, colorScheme: theme });
      const page = await context.newPage(); page.setDefaultTimeout(10000);
      const errors = []; const requests = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', req => requests.push(new URL(req.url()).pathname + new URL(req.url()).search));
      await openUi(page, daemon);
      await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
      if (mobile) await page.getByRole('button', { name: '打开线程列表', exact: true }).click();
      await page.locator('.sidebar').getByRole('button', { name: '配置', exact: true }).click();
      await page.locator('.settings-page').waitFor();
      await page.waitForFunction(() => Math.abs(document.querySelector('.main').getBoundingClientRect().x) < 1);
      assert.equal(await page.locator('.sidebar').isVisible(), false, 'settings replaces the conversation sidebar');
      assert.equal(await page.locator('.sidebar-resize-handle').isVisible(), false);
      assert.ok(Math.abs((await page.locator('.settings-page').boundingBox()).width - page.viewportSize().width) < 1, 'settings fills the window');
      if (!mobile) await page.keyboard.press('Control+Shift+S');
      else {
        const touch = await context.newCDPSession(page);
        await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 6, y: 300 }] });
        await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 160, y: 300 }] });
        await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        assert.equal(await page.locator('.drawer-open').count(), 0, 'settings does not open the conversation sidebar with an edge swipe');
        await touch.detach();
      }
      assert.equal(await page.getByRole('dialog').count(), 0);
      await page.screenshot({ path: `${shots}/index-${mobile ? 'phone' : 'desktop'}-${theme}.png`, animations: 'disabled' });
      await page.locator('.settings-nav').getByRole('button', { name: '常规', exact: true }).click();
      const general = page.getByRole('region', { name: '常规', exact: true });
      await general.getByRole('button', { name: '默认打开页面', exact: true }).click();
      const menu = page.getByRole('menu', { name: '默认打开页面', exact: true });
      const rect = await menu.boundingBox();
      assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= (mobile ? 390 : 1440), 'anchored menu fits the viewport');
      assert.equal(await page.locator('.pop-scrim').count(), 0);
      await page.keyboard.press('Escape');
      await general.waitFor();
      await navigate(page, '#/settings/push');
      const push = page.getByRole('region', { name: '推送', exact: true });
      const toggle = push.getByRole('switch', { name: '一轮失败', exact: true });
      await toggle.waitFor();
      const initial = await toggle.getAttribute('aria-checked');
      assert.equal(requests.filter(path => path === '/api/push/status').length, 0, 'full push records stay unloaded');
      await toggle.click();
      await page.locator('.settings-topbar').getByRole('button', { name: '返回', exact: true }).click();
      const warning = page.getByRole('dialog', { name: '保留这次修改？', exact: true });
      await warning.getByRole('button', { name: '取消', exact: true }).click();
      assert.notEqual(await toggle.getAttribute('aria-checked'), initial);
      await page.route('**/api/push/settings', route => route.request().method() === 'PUT' ? route.fulfill({ status: 500, json: { error: 'Save failed for test' } }) : route.continue());
      await push.getByRole('button', { name: '保存', exact: true }).click();
      await push.getByRole('alert').filter({ hasText: 'Save failed for test' }).waitFor();
      await page.unroute('**/api/push/settings');
      await push.getByRole('button', { name: '保存', exact: true }).click();
      await push.getByRole('status').filter({ hasText: '已保存' }).waitFor();
      await push.getByRole('button', { name: /^最近/ }).click();
      await page.waitForFunction(() => Boolean(document.querySelector('.push-records')));
      assert.equal(requests.filter(path => path === '/api/push/status').length, 1);
      await page.screenshot({ path: `${shots}/push-${mobile ? 'phone' : 'desktop'}-${theme}.png`, animations: 'disabled' });
      await navigate(page, '#/settings/assistant');
      await page.locator('.settings-related').waitFor();
      const profilePath = '/api/personal/profile';
      const before = requests.filter(path => path === profilePath).length;
      await page.getByRole('button', { name: '我在意什么', exact: true }).click();
      await page.locator('.profile-field').waitFor();
      assert.equal(requests.filter(path => path === profilePath).length, before + 1);
      await page.locator('.profile-field').fill('Unsaved profile draft');
      await page.goBack();
      await warning.waitFor();
      await warning.getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(await page.locator('.profile-field').inputValue(), 'Unsaved profile draft');
      assert.ok(page.url().endsWith('#/settings/assistant/profile'));
      await page.locator('.settings-topbar').getByRole('button', { name: '返回', exact: true }).click();
      await warning.getByRole('button', { name: '放弃修改', exact: true }).click();
      await page.locator('.settings-related').waitFor();
      await navigate(page, '#/settings/machines');
      await page.getByRole('button', { name: '添加机器', exact: true }).waitFor();
      await page.screenshot({ path: `${shots}/machines-${mobile ? 'phone' : 'desktop'}-${theme}.png`, animations: 'disabled' });
      // Going into settings must preserve the active conversation, draft and reading position.
      await page.locator('.settings-topbar').getByRole('button', { name: '返回', exact: true }).click();
      if (mobile) {
        await page.locator('.settings-topbar').getByRole('button', { name: '返回', exact: true }).click();
        await page.getByRole('button', { name: '打开线程列表', exact: true }).click();
      }
      await page.locator('.sidebar .thread-item', { hasText: 'Navigation return' }).click();
      await page.locator('.composer textarea').fill('Draft survives settings');
      await page.waitForFunction(() => document.querySelector('.scroller')?.scrollHeight > innerHeight);
      await page.locator('.scroller').hover();
      await page.mouse.wheel(0, -400);
      await page.waitForFunction(() => { const el = document.querySelector('.scroller'); return el.scrollHeight - el.scrollTop - el.clientHeight >= 390; });
      const scroll = await page.locator('.scroller').evaluate(el => el.scrollTop);
      if (mobile) await page.getByRole('button', { name: '打开线程列表', exact: true }).click();
      await page.locator('.sidebar').getByRole('button', { name: '配置', exact: true }).click();
      await page.locator('.settings-topbar').getByRole('button', { name: '返回', exact: true }).click();
      assert.equal(await page.locator('.composer textarea').inputValue(), 'Draft survives settings');
      if (!mobile) assert.equal(await page.locator('.sidebar').isVisible(), true, 'return restores the sidebar preference');
      await page.waitForFunction(top => Math.abs(document.querySelector('.scroller').scrollTop - top) < 2, scroll).catch(async () => {
        assert.fail(JSON.stringify({ mobile, theme, expectedScroll: scroll, actual: await page.locator('.scroller').evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight })) }));
      });
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); await daemon.stop(); }
});
