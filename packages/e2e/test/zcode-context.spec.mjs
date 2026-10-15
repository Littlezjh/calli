import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, openUi, api, launchBrowser, repoRoot } from '../harness.mjs';

let daemon;
let browser;
before(async () => {
  daemon = await startDaemon({ RAH_AGENTS_JSON: JSON.stringify({ agents: [
    { id: 'zcode', adapter: 'zcode', command: [process.execPath, join(repoRoot, 'daemon/test/fixtures/fake-zcode.mjs')], env: { FAKE_ZCODE_CONTEXT: '1' } },
    { id: 'zcode-unknown', adapter: 'zcode', command: [process.execPath, join(repoRoot, 'daemon/test/fixtures/fake-zcode.mjs')] },
  ] }) });
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); await daemon?.stop(); });

async function waitIdle(id) {
  for (let i = 0; i < 160; i++) {
    const thread = await (await api(daemon, `/api/threads/${id}`)).json();
    if (thread.status === 'idle') return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('The zcode turn did not settle');
}

test('zcode context and compression work with measured or unknown usage on desktop and phone in both themes', async () => {
  for (const mobile of [false, true]) for (const colorScheme of ['light', 'dark']) for (const measured of [true, false]) {
    const title = `上下文 ${mobile ? '手机' : '桌面'} ${colorScheme} ${measured ? '已测量' : '未知'}`;
    const response = await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: measured ? 'zcode' : 'zcode-unknown', cwd: daemon.workdir, title }) });
    assert.equal(response.status, 201);
    const thread = await response.json();
    assert.ok((await api(daemon, `/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'hello' }) })).ok);
    await waitIdle(thread.id);
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, colorScheme });
    try {
      const page = await context.newPage();
      await openUi(page, daemon);
      if (mobile) await page.locator('.menu-btn').click();
      await page.locator('.thread-title', { hasText: title }).first().click();
      // On phones the visible trigger is the ring; its text is intentionally hidden.
      await page.locator('.usage:visible').getByText(measured ? '38%' : '上下文', { exact: true }).waitFor({ state: 'attached' });
      const input = page.locator('.composer textarea');
      await input.fill('压缩后保留这段草稿');
      await page.locator('.usage:visible').click();
      await page.getByText(measured ? '上下文已用 48k / 128k' : '暂未获取上下文用量，下一次响应后更新。', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
      if (process.env.RAH_E2E_SHOTS_DIR) {
        mkdirSync(process.env.RAH_E2E_SHOTS_DIR, { recursive: true });
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(process.env.RAH_E2E_SHOTS_DIR, `zcode-context-${mobile ? 'phone' : 'desktop'}-${colorScheme}-${measured ? 'measured' : 'unknown'}.png`) });
      }
      await page.getByRole('button', { name: '压缩 精简较早的对话，释放上下文', exact: true }).click();
      await page.getByText('已压缩', { exact: true }).waitFor();
      await waitIdle(thread.id);
      await page.locator('.usage:visible').getByText(measured ? '6%' : '上下文', { exact: true }).waitFor({ state: 'attached' });
      assert.equal(await input.inputValue(), '压缩后保留这段草稿');
    } finally { await context.close(); }
  }
});
