// The layout rules in AGENTS.md ("布局稳定", no sideways scrolling on a phone, a click doesn't move
// the page) held on every screen in screens/catalog.mjs, phone and desktop, light and dark, on a
// hub of made-up data. A new page or async area joins the catalog and is held here too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser } from '../harness.mjs';
import { seedHub } from '../screens/seed.mjs';
import { shots, newScreenPage, openScreen, measure, VIEWPORTS } from '../screens/catalog.mjs';

// Layout-shift score from first paint to a settled screen. Chrome calls under 0.1 "good"; a
// screen that loads in place should be far below that.
const MAX_SHIFT = 0.02;

// Breaks found when this test was written and not fixed yet, by screen prefix. A listed screen
// that passes fails the test too, so the entry is removed with the fix. Add nothing new here.
const KNOWN = {};
const known = (name) => Object.keys(KNOWN).find((prefix) => name.startsWith(prefix + '-'));

test('every catalog screen loads without jumping or scrolling sideways', { timeout: 600_000 }, async () => {
  const seed = await seedHub();
  const browser = await launchBrowser();
  const failures = [];
  try {
    for (const { screen, viewport, theme } of shots()) {
      const name = `${screen.id}-${viewport.id}-${theme}`;
      const page = await newScreenPage(browser, viewport, theme);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await openScreen(page, seed, screen, viewport);
        const m = await measure(page, viewport);
        const shifted = m.shift > MAX_SHIFT;
        if (shifted && !known(name)) failures.push(`${name}: layout shift ${m.shift} from ${m.shiftSources.join(', ')}`);
        if (!shifted && known(name)) failures.push(`${name}: holds still now; remove it from KNOWN`);
        if (m.overflow.length) failures.push(`${name}: sticks out past the right edge: ${m.overflow.join('; ')}`);
        if (errors.length) failures.push(`${name}: page errors: ${errors.join('; ')}`);
      } finally {
        await page.context().close();
      }
    }
  } finally {
    await browser.close();
    await seed.stop();
  }
  assert.deepEqual(failures, []);
});

test('unfolding a turn\'s work leaves the clicked row where it was', { timeout: 120_000 }, async () => {
  const seed = await seedHub();
  const browser = await launchBrowser();
  try {
    for (const viewport of VIEWPORTS) {
      const page = await newScreenPage(browser, viewport, 'light');
      try {
        const screen = { hash: (s) => `#/thread/${encodeURIComponent(s.threads.rich.id)}`, ready: '.work-toggle' };
        await openScreen(page, seed, screen, viewport);
        const toggle = page.locator('button.work-toggle').last();
        await toggle.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        const before = await toggle.boundingBox();
        await toggle.click();
        await page.waitForTimeout(400);
        const after = await toggle.boundingBox();
        assert.equal(await toggle.getAttribute('aria-expanded'), 'true', `${viewport.id}: the work unfolds`);
        assert.ok(Math.abs(before.y - after.y) < 2, `${viewport.id}: the clicked row moved ${before.y} → ${after.y}`);
      } finally {
        await page.context().close();
      }
    }
  } finally {
    await browser.close();
    await seed.stop();
  }
});
