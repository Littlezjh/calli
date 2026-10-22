// The quota board names the plan each account is on, quietly beside the agent's name, and says
// nothing for an agent that does not report one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon, openUi, launchBrowser } from '../harness.mjs';

test('the quota board shows each account plan beside its name', { timeout: 180000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'rah-quota-plan-'));
  let daemon, browser;
  try {
    const fixtures = fileURLToPath(new URL('../../daemon/test/fixtures/', import.meta.url));
    const fakeCodex = join(home, 'fake-codex');
    writeFileSync(fakeCodex, `#!/bin/sh\nexec '${process.execPath}' '${join(fixtures, 'fake-codex.mjs')}' "$@"\n`, { mode: 0o755 });
    // A Max 20x login; its tokens must never reach the page.
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-secret-access', subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } }));
    daemon = await startDaemon({ RAH_CODEX_BIN: fakeCodex, RAH_CLAUDE_QUOTA_BIN: join(fixtures, 'fake-claude-usage.sh'), HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex') });
    browser = await launchBrowser();
    const shots = process.env.RAH_E2E_SHOTS_DIR;
    if (shots) mkdirSync(shots, { recursive: true });
    for (const phone of [false, true]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 960 }, isMobile: phone, hasTouch: phone, colorScheme: theme });
      try {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        await openUi(page, daemon);
        if (phone) await page.locator('.menu-btn').click();
        await page.getByRole('button', { name: '配置', exact: true }).click();
        await page.getByRole('menuitem', { name: '额度', exact: true }).click();
        const board = page.getByRole('dialog', { name: '额度看板', exact: true });
        const plan = (agent) => board.locator('.quota-board-row', { has: page.locator('.quota-board-name', { hasText: new RegExp(`^${agent}$`) }) }).locator(phone ? '.quota-plan.under' : '.quota-plan.beside');
        await plan('Claude Code').filter({ hasText: 'Max 20x' }).waitFor({ timeout: 30_000 });
        assert.equal(await board.locator(phone ? '.quota-plan.beside' : '.quota-plan.under').first().isVisible(), false, 'shown once, in the place that fits');
        await plan('Codex').filter({ hasText: 'Pro 5x' }).waitFor({ timeout: 30_000 });
        assert.equal(await plan('Codex').getAttribute('title'), 'prolite', "the agent's own word for it, on hover");
        assert.equal(await plan('pi').count(), 0, 'an agent without a plan shows none');
        assert.equal(await plan('TRAE CLI').count(), 0, 'nor does one that has no plan at all');
        assert.doesNotMatch(await board.innerText(), /secret/);
        // Quiet: the plan is not bolder or louder than the name it sits beside.
        const [name, label] = await Promise.all([
          board.locator('.quota-board-name', { hasText: /^Codex$/ }).evaluate((el) => getComputedStyle(el).fontWeight),
          plan('Codex').evaluate((el) => getComputedStyle(el).fontWeight),
        ]);
        assert.ok(Number(label) < Number(name), `plan weight ${label} vs name ${name}`);
        if (shots) await page.screenshot({ path: join(shots, `quota-plan-${phone ? 'phone' : 'desktop'}-${theme}.png`), animations: 'disabled' });
        assert.deepEqual(errors, []);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
      } finally { await context.close(); }
    }
  } finally {
    await browser?.close();
    await daemon?.stop();
    rmSync(home, { recursive: true, force: true });
  }
});
