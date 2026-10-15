import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, openUi, api, launchBrowser, repoRoot } from '../harness.mjs';

let daemon, browser, thread;
before(async () => {
  daemon = await startDaemon({ FAKE_TELEMETRY: '1', RAH_AGENTS_JSON: JSON.stringify({ agents: [
    { id: 'pi', adapter: 'pi', command: [process.execPath, join(repoRoot, 'daemon/test/fixtures/fake-pi.mjs')] },
    { id: 'zcode-empty', adapter: 'zcode', command: [process.execPath, join(repoRoot, 'daemon/test/fixtures/fake-zcode.mjs')], env: { FAKE_ZCODE_NO_MODELS: '1' } },
  ] }) });
  browser = await launchBrowser();
  thread = await (await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: daemon.workdir, title: '用量统计验收' }) })).json();
  assert.ok((await api(daemon, `/api/threads/${thread.id}/turns`, { method: 'POST', body: JSON.stringify({ text: 'hello' }) })).ok);
  for (let i = 0; i < 100; i++) {
    if ((await (await api(daemon, `/api/threads/${thread.id}`)).json()).status === 'idle') break;
    await new Promise(r => setTimeout(r, 50));
  }
});
after(async () => { await browser?.close(); await daemon?.stop(); });

test('usage, request details and actionable diagnostics on desktop/phone in light/dark', async () => {
  for (const mobile of [false, true]) for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, colorScheme });
    try {
      const page = await context.newPage();
      await openUi(page, daemon);
      if (mobile) await page.locator('.menu-btn').click();
      await page.getByRole('button', { name: '配置', exact: true }).click();
      await page.getByRole('menuitem', { name: '用量与诊断' }).click();
      const panel = page.getByRole('dialog', { name: '用量与诊断', exact: true });
      await panel.getByText('TPM · 最近 60 秒', { exact: true }).waitFor();
      assert.equal(await panel.locator('.obs-metric').nth(1).locator('strong').innerText(), '170');
      await panel.locator('.obs-turn summary').click();
      await panel.getByText('fixture-model · fixture-provider').waitFor();
      await panel.getByText('估算 USD 0.0123', { exact: true }).last().waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      if (process.env.RAH_E2E_SHOTS_DIR) {
        mkdirSync(process.env.RAH_E2E_SHOTS_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.RAH_E2E_SHOTS_DIR, `usage-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`) });
      }
      await panel.getByRole('button', { name: 'Agent 诊断', exact: true }).click();
      await panel.getByText('没有可选模型', { exact: true }).waitFor({ timeout: 30000 });
      const empty = panel.locator('.obs-diagnostic').filter({ has: page.getByText('没有可选模型', { exact: true }) });
      await empty.scrollIntoViewIfNeeded();
      await empty.getByRole('button', { name: /刷新 .* 诊断/ }).click();
      await empty.getByText('没有可选模型', { exact: true }).waitFor();
      await empty.locator('button[disabled]').waitFor({ state: 'hidden' });
      await empty.getByRole('button', { name: /复制 .* 诊断/ }).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      if (process.env.RAH_E2E_SHOTS_DIR) await page.screenshot({ path: join(process.env.RAH_E2E_SHOTS_DIR, `diagnostics-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`) });
      await panel.getByRole('button', { name: '关闭', exact: true }).click();
      await panel.waitFor({ state: 'hidden' });
    } finally { await context.close(); }
  }
});
