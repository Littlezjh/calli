// The screens every UI change is looked at and measured on: each core page, at phone and desktop
// widths, light and dark. A new page or a new async area gets an entry here, so screens.mjs
// photographs it and test/ui-rules.spec.mjs holds it to the layout rules.
import { TOKEN } from '../harness.mjs';

export const VIEWPORTS = [
  { id: 'phone', width: 390, height: 844, mobile: true },
  { id: 'desktop', width: 1440, height: 900, mobile: false },
];

export const THEMES = ['light', 'dark'];

/**
 * `hash(seed)` is the address the screen opens at; `ready` is a selector that is on screen once
 * its content has arrived; `phone` runs after load on a phone (opening the drawer, for one).
 */
export const SCREENS = [
  {
    id: 'thread',
    name: '对话',
    hash: (seed) => `#/thread/${encodeURIComponent(seed.threads.rich.id)}`,
    ready: '.work-toggle',
  },
  {
    id: 'thread-error',
    name: '出错的对话',
    hash: (seed) => `#/thread/${encodeURIComponent(seed.threads.failed.id)}`,
    ready: '.composer',
  },
  {
    id: 'threads',
    name: '线程列表',
    hash: (seed) => `#/thread/${encodeURIComponent(seed.threads.rich.id)}`,
    ready: '.thread-row',
    phone: async (page) => {
      await page.locator('.menu-btn').first().click();
      await page.locator('.app.drawer-open').waitFor();
    },
    desktopSkip: true, // the desktop list is already in the thread screen
  },
  { id: 'settings', name: '设置', hash: () => '#/settings', ready: '.settings-page' },
  { id: 'agents', name: '智能体', hash: () => '#/agents', ready: '.main' },
  { id: 'activity', name: '活动', hash: () => '#/activity', ready: '.main' },
  { id: 'schedules', name: '定时任务', hash: () => '#/schedules', ready: '.main' },
  { id: 'todos', name: '待办', hash: () => '#/todos', ready: '.main' },
];

/** Every screen × viewport × theme the catalog covers. */
export function* shots() {
  for (const screen of SCREENS) for (const viewport of VIEWPORTS) {
    if (!viewport.mobile && screen.desktopSkip) continue;
    for (const theme of THEMES) yield { screen, viewport, theme };
  }
}

/** A signed-in page in the given viewport and theme, recording layout shifts from its first paint. */
export async function newScreenPage(browser, viewport, theme) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    isMobile: viewport.mobile,
    hasTouch: viewport.mobile,
    colorScheme: theme,
    reducedMotion: 'reduce',
  });
  await context.addInitScript(([mode, token]) => {
    localStorage.setItem('calli.appearance', JSON.stringify({ mode, palette: 'paper' }));
    localStorage.setItem('calli.token', token);
    window.__shifts = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.hadRecentInput) continue;
          window.__shifts.push({
            at: Math.round(entry.startTime),
            value: entry.value,
            nodes: (entry.sources ?? []).map((s) => s.node && s.node.nodeType === 1
              ? `${s.node.tagName.toLowerCase()}${s.node.className && typeof s.node.className === 'string' ? '.' + s.node.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`
              : '#text'),
          });
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch { /* an engine without layout-shift entries records none */ }
  }, [theme, TOKEN]);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  return page;
}

/** Opens a screen and waits for its content and a quiet second after it. */
export async function openScreen(page, seed, screen, viewport) {
  await page.goto(`${seed.daemon.base}/${screen.hash(seed)}`);
  await page.locator(screen.ready).first().waitFor({ state: 'attached' });
  if (viewport.mobile && screen.phone) await screen.phone(page);
  await page.waitForTimeout(1000);
}

/**
 * What the layout rules measure on the screen as it stands:
 * - shift: the summed layout-shift score since load (input-driven shifts excluded), and its sources;
 * - overflow: the page scrolls sideways, or visible boxes stick out past the right edge unclipped;
 * - smallTargets: on a phone, controls smaller than 32px either way (reported, not a hard rule).
 */
export function measure(page, viewport) {
  return page.evaluate((mobile) => {
    const shifts = window.__shifts ?? [];
    const shift = shifts.reduce((sum, s) => sum + s.value, 0);
    const width = window.innerWidth;
    const doc = document.scrollingElement ?? document.documentElement;
    const describe = (el) => `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`;
    const clipped = (el) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const style = getComputedStyle(p);
        if (style.overflowX !== 'visible' && p.getBoundingClientRect().right <= width + 1) return true;
        if (style.position === 'fixed') break;
      }
      return false;
    };
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
    };
    const sticking = [];
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.right <= width + 1 || r.left >= width) continue;
      if (!visible(el) || clipped(el)) continue;
      sticking.push(`${describe(el)} → ${Math.round(r.right)}px`);
      if (sticking.length >= 5) break;
    }
    const smallTargets = [];
    if (mobile) {
      for (const el of document.querySelectorAll('button, a[href], [role="button"], [role="menuitem"], input, textarea')) {
        if (!visible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > width) continue;
        if (r.width < 32 || r.height < 32) smallTargets.push(`${el.getAttribute('aria-label') || describe(el)} ${Math.round(r.width)}×${Math.round(r.height)}`);
      }
    }
    return {
      shift: Math.round(shift * 1000) / 1000,
      shiftSources: [...new Set(shifts.filter((s) => s.value >= 0.005).flatMap((s) => s.nodes))].slice(0, 6),
      overflow: doc.scrollWidth > doc.clientWidth + 1 ? [`page scrolls sideways: ${doc.scrollWidth} > ${doc.clientWidth}`, ...sticking] : sticking,
      smallTargets,
    };
  }, viewport.mobile);
}
