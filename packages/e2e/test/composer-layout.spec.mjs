import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, openUi, openCollaboration, api, launchBrowser, repoRoot } from '../harness.mjs';

test('the simplified composer fits narrow screens and keeps permission, collaboration, context and quota reachable', { timeout: 180000 }, async () => {
  const daemon = await startDaemon({ CALLI_AGENTS_JSON: JSON.stringify({ agents: [{
    id: 'codex', adapter: 'codex', command: [process.execPath, join(repoRoot, 'daemon/test/fixtures/fake-codex.mjs')],
  }] }) });
  const browser = await launchBrowser();
  const shots = process.env.CALLI_E2E_SHOTS_DIR;
  if (shots) mkdirSync(shots, { recursive: true });
  const post = async (path, body) => {
    const response = await api(daemon, path, { method: 'POST', body: JSON.stringify(body) });
    assert.ok(response.ok, await response.clone().text());
    return response.status === 204 ? null : response.json();
  };
  try {
    await post('/api/extensions/voice/install', { granted: ['voice.control'] });
    for (const width of [320, 390, 1440]) for (const colorScheme of ['light', 'dark']) {
      const mobile = width < 600;
      const context = await browser.newContext({ viewport: { width, height: mobile ? 844 : 1000 }, isMobile: mobile, hasTouch: mobile, colorScheme });
      const page = await context.newPage(); page.setDefaultTimeout(10000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      const thread = await post('/api/threads', { agent: 'codex', cwd: daemon.workdir, title: `Composer ${width} ${colorScheme}`, permissionMode: 'full_access' });
      let quotaReads = 0;
      await page.route('**/api/agents/*/quota*', route => {
        quotaReads++;
        return route.fulfill({ json: { checkedAt: new Date().toISOString(), windows: [{ label: '7D', usedPercent: 59 }] } });
      });
      try {
        await post(`/api/threads/${thread.id}/turns`, { text: 'slow' });
        await openUi(page, daemon);
        if (mobile) await page.getByRole('button', { name: '打开线程列表', exact: true }).click();
        await page.locator('.sidebar .thread-item', { hasText: thread.title }).click();
        const input = page.locator('.composer textarea'); await input.fill('这段草稿需要保留');
        const permission = page.getByRole('button', { name: '权限：完全访问权限', exact: true });
        await permission.waitFor();
        assert.equal(await permission.innerText(), '', 'permissions use the existing icon without the wide text');
        assert.equal(await permission.locator('svg').count(), 1);
        assert.equal(await page.locator('.composer .usage, .composer .chat-quota-trigger, .composer .coord-tool').count(), 0);
        assert.equal(await page.locator('.topbar [role=meter], .chat-quota-preview').count(), 0);
        assert.equal(quotaReads, 0, 'chat does not read quotas until the menu opens');
        const fits = async () => {
          const overflow = await page.locator('.composer-bar').evaluate(bar => {
            const box = bar.getBoundingClientRect();
            return [...bar.querySelectorAll('button')].filter(button => {
              const r = button.getBoundingClientRect();
              return r.width > 0 && (r.left < box.left - 1 || r.right > box.right + 1 || r.bottom > innerHeight + 1);
            }).map(button => button.getAttribute('aria-label'));
          });
          assert.deepEqual(overflow, [], `all composer actions fit at ${width}px`);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        };
        await page.getByRole('button', { name: '停止', exact: true }).waitFor();
        await page.getByRole('button', { name: '排队发送', exact: true }).waitFor();
        await page.getByRole('button', { name: '开启实时语音', exact: true }).waitFor();
        await fits();
        await permission.click();
        const permissions = page.getByRole('menu', { name: '权限', exact: true });
        assert.equal(await permissions.getByRole('menuitemradio').count(), 3);
        assert.equal(await permissions.getByText('额度查询', { exact: true }).count(), 0);
        await page.keyboard.press('Escape');
        await openCollaboration(page);
        assert.equal(quotaReads, 0);
        await page.keyboard.press('Escape');
        const model = page.locator('.model-control-trigger'); await model.click();
        await page.locator('.model-context').waitFor();
        if (mobile) {
          await page.setViewportSize({ width, height: 460 });
          await page.waitForFunction(() => {
            const r = document.querySelector('.model-control-panel')?.getBoundingClientRect();
            return r && r.y >= 0 && r.bottom <= innerHeight + 1;
          });
          await fits();
          if (shots) await page.screenshot({ path: join(shots, `composer-keyboard-${width}-${colorScheme}.png`), animations: 'disabled' });
          await page.setViewportSize({ width, height: 844 });
        }
        await page.keyboard.press('Escape');
        if (shots) {
          await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
          await page.screenshot({ path: join(shots, `composer-${width}-${colorScheme}.png`), animations: 'disabled' });
        }
        await page.locator('.topbar-more').click();
        const quick = page.locator('.quota-menu-preview');
        await quick.getByRole('meter').filter({ hasText: '41%' }).waitFor();
        assert.equal(quotaReads, 1);
        assert.equal(await quick.getByText('未提供', { exact: true }).count(), 1);
        await page.keyboard.press('Escape');
        assert.equal(await input.inputValue(), '这段草稿需要保留');
        await fits();
        // Sending during work queues the draft, then stopping restores an editable composer.
        await page.getByRole('button', { name: '排队发送', exact: true }).click();
        await page.locator('.queue-item', { hasText: '这段草稿需要保留' }).waitFor();
        await page.getByRole('button', { name: '撤回到输入框里编辑', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.composer textarea')?.value === '这段草稿需要保留');
        assert.equal(await input.inputValue(), '这段草稿需要保留');
        await page.getByRole('button', { name: '停止', exact: true }).click();
        await page.getByRole('button', { name: '发送', exact: true }).waitFor();
        assert.equal(await input.inputValue(), '这段草稿需要保留');
        assert.deepEqual(errors, []);
      } finally {
        await api(daemon, `/api/threads/${thread.id}/cancel`, { method: 'POST' });
        await context.close();
      }
    }
  } finally { await browser.close(); await daemon.stop(); }
});
