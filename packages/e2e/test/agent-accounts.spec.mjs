import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon, openUi, api, launchBrowser } from '../harness.mjs';

for (const adapter of ['claude', 'agy']) test(`${adapter}: independent account creation and code login on desktop and phone, light and dark`, { timeout: 120_000 }, async () => {
  const source = mkdtempSync(join(tmpdir(), 'calli-e2e-account-source-'));
  const config = adapter === 'claude' ? source : join(source, '.gemini', 'antigravity-cli');
  mkdirSync(config, { recursive: true });
  const credentials = join(config, adapter === 'claude' ? '.credentials.json' : 'antigravity-oauth-token');
  writeFileSync(join(config, adapter === 'claude' ? 'CLAUDE.md' : 'GEMINI.md'), 'Shared instructions');
  writeFileSync(credentials, 'existing account');
  if (adapter === 'agy') {
    // Reproduce native optional configuration left as zero-byte or whitespace-only files.
    mkdirSync(join(source, '.gemini', 'config'), { recursive: true });
    writeFileSync(join(source, '.gemini', 'config', 'mcp_config.json'), '');
    writeFileSync(join(config, 'settings.json'), ' \n\t');
  }
  const label = adapter === 'claude' ? 'Claude Code' : 'Antigravity';
  const email = adapter === 'claude' ? 'new@example.com' : 'agy-new@example.com';
  const fixture = fileURLToPath(new URL('../../daemon/test/fixtures/fake-claude-auth.mjs', import.meta.url));
  const daemon = await startDaemon({
    CALLI_AGENTS_JSON: JSON.stringify({ agents: [{ id: adapter, adapter, command: [adapter === 'claude' ? 'fake-claude' : 'fake-agy'], env: adapter === 'claude' ? { CLAUDE_CONFIG_DIR: source, CALLI_CLAUDE_BIN: fixture } : { HOME: source, CALLI_AGY_HOME: config } }] }),
  });
  let browser;
  try {
    browser = await launchBrowser();
    for (const mobile of [false, true]) for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, colorScheme });
      try {
        await context.addInitScript(() => localStorage.setItem('calli_onboard_dismissed', '1'));
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        const mode = `${mobile ? 'phone' : 'desktop'}-${colorScheme}`;
        const shot = async name => {
          if (!process.env.CALLI_E2E_SHOTS_DIR) return;
          mkdirSync(process.env.CALLI_E2E_SHOTS_DIR, { recursive: true });
          await page.screenshot({ path: join(process.env.CALLI_E2E_SHOTS_DIR, `accounts-${adapter}-${mode}-${name}.png`), animations: 'disabled' });
        };
        await openUi(page, daemon);
        await page.evaluate(() => { location.hash = '#/agents'; });
        await page.locator('.agents-page').waitFor();
        await page.getByRole('button', { name: '添加 agent', exact: true }).click();
        await page.locator('.agent-account-dialog .choice-row').filter({ hasText: label }).waitFor();
        await shot('choices');
        await page.locator('.agent-account-dialog .choice-row').filter({ hasText: label }).click();
        const name = `${label} ${mode}`;
        await page.getByLabel('名称（选填）').fill(name);
        await shot('add');
        await page.getByRole('button', { name: '添加账号', exact: true }).click();
        await page.locator('.agent-account-dialog').waitFor({ state: 'detached' });
        const row = page.locator('.agents-row').filter({ hasText: name });
        await row.getByText('待登录', { exact: false }).waitFor();
        await shot('list');
        await row.getByRole('button', { name: '登录', exact: true }).click();
        const link = page.getByRole('link', { name: '打开登录链接' });
        await link.waitFor();
        assert.equal(new URL(await link.getAttribute('href')).hostname, adapter === 'claude' ? 'claude.com' : 'accounts.google.com');
        assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
        await shot('login');
        const box = await page.locator('.agent-login-dialog').boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= (mobile ? 390 : 1440));
        assert.ok(box.y >= 0 && box.y + box.height <= (mobile ? 844 : 1000));
        assert.ok(await page.getByRole('button', { name: '提交验证码' }).isDisabled());
        if (!mobile && colorScheme === 'dark') {
          await page.route('**/api/agents/*/login/*', route => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'login not found' }) }), { times: 1 });
          await page.getByText('登录链接已过期，请重新登录。').waitFor();
          await page.getByRole('button', { name: '重试', exact: true }).click();
          await link.waitFor();
        }
        if (mobile && colorScheme === 'dark') {
          await page.getByLabel(adapter === 'claude' ? '验证码' : '授权码或回跳地址', { exact: true }).fill('wrong');
          await page.getByRole('button', { name: '提交验证码' }).click();
          await page.getByText('登录未成功，请重试并使用新链接获取验证码。').waitFor();
          await shot('failed');
          await page.getByRole('button', { name: '重试', exact: true }).click();
          await link.waitFor();
        }
        await page.getByLabel(adapter === 'claude' ? '验证码' : '授权码或回跳地址', { exact: true }).fill(adapter === 'claude' ? 'test-code#test-state' : 'https://antigravity.google/oauth-callback?code=test-agy-code&state=fixture');
        await page.getByRole('button', { name: '提交验证码' }).click();
        await page.getByText('登录成功，可以开始新会话了。').waitFor();
        await shot('success');
        await page.getByRole('button', { name: '关闭', exact: true }).click();
        await row.getByText(email, { exact: false }).waitFor();
        await row.getByRole('button', { name: '登录', exact: true }).click();
        await link.waitFor();
        await page.getByRole('button', { name: '取消', exact: true }).click();
        await page.locator('.agent-login-dialog').waitFor({ state: 'detached' });
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
    const agents = await (await api(daemon, '/api/agents')).json();
    assert.equal(agents.filter(a => a.account === email).length, 4);
    assert.equal(readFileSync(credentials, 'utf8'), 'existing account');
  } finally {
    await browser?.close(); await daemon.stop(); rmSync(source, { recursive: true, force: true });
  }
});
