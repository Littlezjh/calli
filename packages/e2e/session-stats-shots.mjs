// Run npm run build from the repository root before capturing screenshots.
// Captures the session-statistics readings and the in-thread trace with its timeline:
// desktop (1440) and phone (390), light and dark, against a real daemon driven by the fake pi
// agent, plus the demo workspace for the hub-estimated (≈) wording.
// Run: node session-stats-shots.mjs (writes PNGs into shots/session-stats/)
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon, launchBrowser, openUi } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'shots', 'session-stats');
mkdirSync(outDir, { recursive: true });

const shot = (page, name, opts = {}) => page.screenshot({ path: join(outDir, `${name}.png`), ...opts });

// A conversation with two finished turns, so the readings have a session to summarize. Plain
// prompts: the fake agent answers them with tool calls and (under FAKE_TELEMETRY) a usage sample.
async function makeTurns(page) {
  await page.locator('.composer .context-btn').first().click();
  await page.getByRole('menuitemradio', { name: /^pi/ }).click();
  for (const ask of ['please one', 'please two']) {
    await page.locator('.composer textarea').click();
    await page.keyboard.type(ask);
    // A phone composer sends with the button; Enter only breaks the line there.
    await page.locator('.composer .send-btn:not(.stop)').click();
    await page.getByText(`hi there ${ask}`).waitFor({ timeout: 30_000 });
  }
  // The readings follow at their own pace: one refresh after the last turn settles.
  await page.waitForTimeout(3_600);
}

// The top-bar trace button opens the side panel; a click that lands mid-render is repeated.
async function openTrace(page) {
  for (let i = 0; i < 3; i++) {
    await page.locator('.topbar-trace').click();
    try {
      await page.locator('.trace-side .ov').waitFor({ timeout: 5_000 });
      // Let the panel's slide-in and the first paint settle, so hovers land on steady bars.
      await page.waitForTimeout(700);
      return;
    } catch {
      if (await page.locator('.trace-side').count()) {
        try {
          await page.locator('.trace-side .ov').waitFor({ timeout: 8_000 });
          await page.waitForTimeout(700);
          return;
        } catch { /* no trace yet: click again */ }
      }
    }
  }
  throw new Error('the trace panel did not open');
}

const daemon = await startDaemon({ FAKE_TELEMETRY: '1', FAKE_PI_TWO_REQUESTS: '1' });
const browser = await launchBrowser();
try {
  // ---------- Desktop: readings in the top bar, the trace beside the conversation ----------
  {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await openUi(page, daemon);
    await makeTurns(page);
    await page.waitForTimeout(400);
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.waitForTimeout(300);
    await shot(page, 'desktop-topbar-light', { clip: { x: 640, y: 0, width: 800, height: 260 } });

    // The session reading opens its detail; the token one shows the cache lines.
    await page.locator('[data-testid="session-stats"] .stat').first().click();
    await page.locator('.pop-rows').waitFor({ timeout: 5_000 });
    await page.waitForTimeout(250);
    await shot(page, 'desktop-stats-popover-light');
    await page.keyboard.press('Escape');
    await page.locator('.pop-panel').waitFor({ state: 'detached', timeout: 5_000 });
    await page.locator('[data-testid="session-stats"] .stat').nth(1).click();
    await page.locator('.pop-rows').waitFor({ timeout: 5_000 });
    await page.waitForTimeout(250);
    await shot(page, 'desktop-token-popover-light');
    await page.keyboard.press('Escape');

    // The trace beside the conversation: the timeline pinned, the steps under it.
    await openTrace(page);
    await shot(page, 'desktop-trace-light');
    // Hovering a bar says when it began and how it split; clicking selects and opens its step.
    // The last segment sits at the end of the turn, clear of the tools it answers.
    await page.locator('.trace-side .ov-bar.ov-seg').last().hover();
    await page.locator('.ov-tip').waitFor({ timeout: 5_000 });
    await page.waitForTimeout(200);
    await shot(page, 'desktop-trace-hover-light');
    await page.locator('.trace-side .ov-bar.ov-seg').last().click();
    await page.waitForTimeout(700);
    await shot(page, 'desktop-trace-selected-light');
    for (const theme of ['dark']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await page.waitForTimeout(300);
      await shot(page, `desktop-trace-${theme}`);
      await page.locator('.ov-tip').waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
      await page.locator('.trace-side .ov-bar.tool').last().hover();
      await page.locator('.ov-tip').waitFor({ timeout: 5_000 });
    await page.waitForTimeout(200);
      await shot(page, `desktop-trace-hover-${theme}`);
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    // With the panel open the bar runs out of room and the readings step aside, as they should;
    // close it before the dark top-bar and popover shots.
    await page.locator('.trace-side .icon-btn[aria-label="关闭"]').click();
    await page.locator('.trace-side').waitFor({ state: 'detached', timeout: 5_000 });
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), 'dark');
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await shot(page, 'desktop-topbar-dark', { clip: { x: 640, y: 0, width: 800, height: 260 } });
    await page.locator('[data-testid="session-stats"] .stat').first().click();
    await page.locator('.pop-rows').waitFor({ timeout: 5_000 });
    await page.waitForTimeout(250);
    await shot(page, 'desktop-stats-popover-dark');
    await page.close();
  }

  // ---------- Phone: no readings in the bar; they lead the full-screen trace page ----------
  {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
    await openUi(page, daemon);
    await makeTurns(page);
    await page.waitForTimeout(400);
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await page.waitForTimeout(300);
      await shot(page, `phone-topbar-${theme}`, { clip: { x: 0, y: 0, width: 390, height: 200 } });
      await openTrace(page);
      await shot(page, `phone-trace-${theme}`);
      await page.locator('.trace-side.phone .stats-top .stat').first().click();
      await page.locator('.pop-rows').waitFor({ timeout: 5_000 });
    await page.waitForTimeout(250);
      await shot(page, `phone-stats-sheet-${theme}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      // Back out of the trace page for the next theme.
      await page.getByRole('button', { name: '返回主线程' }).click();
      await page.locator('.trace-side.phone').waitFor({ state: 'detached', timeout: 5_000 });
    }
    await page.close();
  }

  // ---------- The demo workspace: hub-estimated numbers carry the ≈ wording ----------
  {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await page.goto(daemon.base + '/');
    await page.locator('.demo-bar, .sidebar-inner').first().waitFor({ timeout: 15_000 });
    // Pick the example thread; its readings come from the demo data.
    await page.locator('.sidebar .thread-item, .sidebar [class*="thread"]').filter({ hasText: '修复商品列表' }).first().click();
    await page.locator('[data-testid="session-stats"]').waitFor({ timeout: 10_000 });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.waitForTimeout(300);
    await shot(page, 'demo-topbar-light', { clip: { x: 640, y: 0, width: 800, height: 260 } });
    await page.locator('[data-testid="session-stats"] .stat').first().click();
    await page.locator('.pop-rows').waitFor({ timeout: 5_000 });
    await page.waitForTimeout(250);
    await shot(page, 'demo-stats-popover-light');
    await openTrace(page);
    await shot(page, 'demo-trace-light');
    await page.close();
  }
} finally {
  await browser?.close();
  await daemon?.stop();
}
console.log('shots written to', outDir);
