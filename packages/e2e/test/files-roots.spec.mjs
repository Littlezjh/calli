// The file browser beside a conversation: it stands on the thread's folder, and can be moved to
// the machine's project directories and the home directory; a link that names a folder opens it
// in the tree instead of failing; a PDF opens in the browser's own viewer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { startDaemon, openUi, api, launchBrowser } from '../harness.mjs';

let root, home, daemon, browser, messagesFile, sessionId;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'calli-e2e-roots-'));
  home = join(root, 'home');
  mkdirSync(join(home, '家目录子夹'), { recursive: true });
  writeFileSync(join(home, '家目录子夹', '笔记.md'), '# 家里的笔记\n');
  messagesFile = join(mkdtempSync(join(tmpdir(), 'calli-e2e-msgs-')), 'messages.json');
  daemon = await startDaemon({ HOME: home, FAKE_PI_MESSAGES_FILE: messagesFile });
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  await daemon?.stop();
  rmSync(root, { recursive: true, force: true });
  rmSync(join(messagesFile, '..'), { recursive: true, force: true });
});

/** A thread whose imported replies link folders by absolute path. */
async function linkedThread(title) {
  const project = join(root, '另一个项目');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src', 'answer.ts'), 'export const yes = true;\n');
  writeFileSync(join(daemon.workdir, '说明.pdf'), '%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
  const added = await api(daemon, '/api/workdirs', { method: 'POST', body: JSON.stringify({ path: project }) });
  assert.ok(added.status === 200 || (added.status === 400 && /already/.test(await added.text())), 'the project root is added');

  sessionId = randomUUID();
  // The session file the pi adapter scans; the messages come from the script below.
  const sessions = join(daemon.dataDir, 'pi-agent', 'sessions', 'e2e');
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, `e2e_${sessionId}.jsonl`), JSON.stringify({ type: 'session', id: sessionId, cwd: daemon.workdir }) + '\n' + JSON.stringify({ type: 'session_info', name: title }) + '\n');
  writeFileSync(messagesFile, JSON.stringify({
    [sessionId]: [
      { role: 'user', content: '看看这两个地方' },
      { role: 'assistant', content: [{ type: 'text', text: `看这个文件夹：[家目录子夹](${home}/家目录子夹)` }] },
      { role: 'user', content: '再看项目' },
      { role: 'assistant', content: [{ type: 'text', text: `[另一个项目](${project})` }] },
    ],
  }));
  const imported = await api(daemon, '/api/threads/import', { method: 'POST', body: JSON.stringify({ agent: 'pi', sessionId }) });
  assert.equal(imported.status, 201, await imported.text());
  return imported;
}

for (const colorScheme of ['light', 'dark']) {
test(`the file browser moves between the thread folder, projects and home; folder links open the tree: desktop-${colorScheme}`, async () => {
  const title = `浏览位置-${colorScheme}`;
  await linkedThread(title);

  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  try {
    await openUi(page, daemon);
    await page.locator('.thread-item', { hasText: title }).click();

    // Open the panel from the thread menu.
    await page.locator('.topbar-more').click();
    await page.getByRole('menuitem', { name: '文件', exact: true }).click();
    const panel = page.locator('.files-panel');
    await panel.waitFor();

    // Nothing open: the tree is the panel's whole content, not a dead viewer beside it.
    await panel.locator('.files-row', { hasText: '说明.pdf' }).waitFor();
    assert.equal(await panel.locator('.files-body.only-tree').count(), 1, 'the folder takes the panel');
    assert.equal(await panel.locator('.files-viewer').count(), 0, 'no empty viewer');

    // The PDF opens in the browser's own viewer, streamed from a signed link.
    await panel.locator('.files-row', { hasText: '说明.pdf' }).click();
    const frame = panel.locator('.files-pdf iframe');
    await frame.waitFor();
    assert.match(await frame.getAttribute('src'), /\/api\/threads\/.+\/download\?/);
    assert.equal(await panel.locator('.files-body.only-tree').count(), 0, 'a file open splits the panel again');

    // The root switcher: the thread's folder (the workdir, spelled as the thread's own), the
    // project, and the home directory.
    await panel.locator('.files-tree .files-roots').click();
    const menu = page.getByRole('menu', { name: '切换浏览位置' });
    await menu.waitFor();
    assert.deepEqual(
      (await menu.locator('.files-roots-text-kind').allTextContents()).sort(),
      ['线程目录', '项目目录', '家目录'].sort(),
    );
    await menu.getByRole('menuitemradio', { name: /另一个项目/ }).click();
    await panel.locator('.files-row', { hasText: 'src' }).click();
    await panel.locator('.files-row', { hasText: 'answer.ts' }).waitFor();

    // The filter looks through the root the tree stands on.
    await panel.locator('.files-filter input').fill('answer');
    await panel.locator('.files-results .files-row', { hasText: 'answer.ts' }).click();
    await panel.locator('.files-code').waitFor();
    assert.match(await panel.locator('.files-code').innerText(), /export const yes = true/);

    // Home: the home directory is right there, dotfiles and all.
    await panel.locator('.files-tree .files-roots').click();
    await page.getByRole('menu', { name: '切换浏览位置' }).getByRole('menuitemradio', { name: /家目录/ }).click();
    await panel.locator('.files-row', { hasText: '家目录子夹' }).click();
    await panel.locator('.files-row', { hasText: '笔记.md' }).waitFor();

    // A reply's link that names a folder stands the tree in it, wherever it is.
    await page.locator('a.file-link', { hasText: '另一个项目' }).click();
    await panel.locator('.files-row', { hasText: 'src' }).waitFor();
    const rootsName = await panel.locator('.files-tree .files-roots-name').innerText();
    assert.equal(rootsName, '另一个项目', 'the tree moved with the link');

    if (process.env.CALLI_E2E_SHOTS_DIR) {
      mkdirSync(process.env.CALLI_E2E_SHOTS_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.CALLI_E2E_SHOTS_DIR, `files-roots-desktop-${colorScheme}.png`) });
    }
  } finally {
    await context.close();
  }
});
}

for (const colorScheme of ['light', 'dark']) {
test(`on a phone the root switcher sits on the folder page: phone-${colorScheme}`, async () => {
  const title = `浏览位置手机-${colorScheme}`;
  await linkedThread(title);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  try {
    await openUi(page, daemon);
    await page.locator('.menu-btn').click();
    await page.locator('.thread-item', { hasText: title }).click();
    await page.locator('a.file-link', { hasText: '家目录子夹' }).first().click();
    const panel = page.locator('.files-panel.phone');
    await panel.waitFor();
    // The link opened the folder page with the tree standing in the home directory.
    await panel.locator('.files-row', { hasText: '笔记.md' }).waitFor();
    assert.equal(await panel.locator('.files-roots-name').innerText(), 'home', 'the chip names the root, not the folder');
    await panel.locator('.files-roots').click();
    await page.getByRole('menu', { name: '切换浏览位置' }).getByRole('menuitemradio', { name: /线程目录/ }).click();
    await panel.locator('.files-row', { hasText: '说明.pdf' }).waitFor();
    if (process.env.CALLI_E2E_SHOTS_DIR) {
      mkdirSync(process.env.CALLI_E2E_SHOTS_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.CALLI_E2E_SHOTS_DIR, `files-roots-phone-${colorScheme}.png`) });
    }
  } finally {
    await context.close();
  }
});
}

for (const colorScheme of ['light', 'dark']) {
test(`deep file breadcrumbs collapse without overlapping on desktop and phone: ${colorScheme}`, async () => {
  const deepDir = join(
    daemon.workdir,
    '.local',
    'state',
    'remote-agent-hub',
    'data',
    'agent-accounts',
    'agy-4-demo01',
    '.claude',
    'projects',
    '-srv-home-alice-code-calli',
    'memory',
  );
  mkdirSync(deepDir, { recursive: true });
  const deepFile = join(deepDir, 'deep-breadcrumb-regression-note.md');
  writeFileSync(deepFile, '# Deep Note\n\nBreadcrumb overlap regression check.\n');

  const title = `深路径面包屑-${colorScheme}`;
  const sid = randomUUID();
  const sessions = join(daemon.dataDir, 'pi-agent', 'sessions', 'e2e');
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, `e2e_${sid}.jsonl`), JSON.stringify({ type: 'session', id: sid, cwd: daemon.workdir }) + '\n' + JSON.stringify({ type: 'session_info', name: title }) + '\n');
  writeFileSync(messagesFile, JSON.stringify({
    [sid]: [
      { role: 'user', content: '打开深路径文件' },
      { role: 'assistant', content: [{ type: 'text', text: `看这里：[deep-breadcrumb-regression-note.md](${deepFile})` }] },
    ],
  }));
  const imported = await api(daemon, '/api/threads/import', { method: 'POST', body: JSON.stringify({ agent: 'pi', sessionId: sid }) });
  assert.equal(imported.status, 201, await imported.text());

  // Desktop: collapsed crumbs do not overlap each other or the action bar, even when narrowed.
  const desktopCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme });
  const page = await desktopCtx.newPage();
  page.setDefaultTimeout(10_000);
  try {
    await openUi(page, daemon);
    await page.locator('.thread-item', { hasText: title }).click();
    await page.locator('a.file-link', { hasText: 'deep-breadcrumb-regression-note.md' }).click();
    const panel = page.locator('.files-panel');
    await panel.locator('.files-markdown').waitFor();

    const checkNoOverlap = async (label) => {
      const layout = await page.evaluate(() => {
        const nav = document.querySelector('.files-crumbs');
        const actions = document.querySelector('.files-actions');
        const items = [...document.querySelectorAll('.files-crumbs > .files-crumb')];
        return {
          navRight: nav.getBoundingClientRect().right,
          actionsLeft: actions.getBoundingClientRect().left,
          items: items.map((el) => {
            const r = el.getBoundingClientRect();
            const labelEl = el.querySelector('button, .files-crumb-current');
            const lr = labelEl ? labelEl.getBoundingClientRect() : r;
            return {
              text: el.textContent?.trim() ?? '',
              left: r.left,
              right: r.right,
              width: r.width,
              labelLeft: lr.left,
              labelRight: lr.right,
              overflow: getComputedStyle(el).overflowX,
            };
          }),
        };
      });
      assert.ok(layout.navRight <= layout.actionsLeft + 1, `${label}: crumbs run into actions (${layout.navRight} > ${layout.actionsLeft})`);
      for (let i = 1; i < layout.items.length; i++) {
        const prev = layout.items[i - 1];
        const curr = layout.items[i];
        assert.ok(prev.right <= curr.left + 1, `${label}: crumb "${prev.text}" overlaps "${curr.text}" (${prev.right} > ${curr.left})`);
        if (prev.overflow !== 'hidden') {
          assert.ok(prev.labelRight <= prev.right + 1, `${label}: unclipped crumb "${prev.text}" bleeds out (${prev.labelRight} > ${prev.right})`);
        }
      }
      const last = layout.items[layout.items.length - 1];
      assert.ok(last.width > 40, `${label}: file name stays readable (${last.width}px)`);
    };

    await checkNoOverlap(`desktop-${colorScheme}-default`);
    if (process.env.CALLI_E2E_SHOTS_DIR) {
      mkdirSync(process.env.CALLI_E2E_SHOTS_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.CALLI_E2E_SHOTS_DIR, `files-crumbs-desktop-${colorScheme}.png`) });
    }

    // Ellipsis menu exposes the collapsed middle folders and opens them in the tree.
    const more = panel.getByRole('button', { name: '展开省略的路径' });
    await more.click();
    const menu = page.getByRole('menu', { name: '展开省略的路径' });
    await menu.waitFor();
    await menu.getByRole('menuitem', { name: '-srv-home-alice-code-calli' }).click();
    await panel.locator('.files-tree .files-row', { hasText: 'memory' }).waitFor();

    // Narrow panel width (380px): still no overlap between crumbs or actions.
    await panel.evaluate((el) => { el.style.width = '380px'; });
    await checkNoOverlap(`desktop-${colorScheme}-narrow`);
    if (process.env.CALLI_E2E_SHOTS_DIR) {
      await page.screenshot({ path: join(process.env.CALLI_E2E_SHOTS_DIR, `files-crumbs-narrow-${colorScheme}.png`) });
    }
  } finally {
    await desktopCtx.close();
  }

  // Phone: header shows file name cleanly and folder sub-breadcrumbs do not overflow the page.
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme });
  const phonePage = await phoneCtx.newPage();
  phonePage.setDefaultTimeout(10_000);
  try {
    await openUi(phonePage, daemon);
    await phonePage.locator('.menu-btn').click();
    await phonePage.locator('.thread-item', { hasText: title }).click();
    await phonePage.locator('a.file-link', { hasText: 'deep-breadcrumb-regression-note.md' }).click();
    const phonePanel = phonePage.locator('.files-panel.phone');
    await phonePanel.locator('.files-markdown').waitFor();
    assert.equal(await phonePage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (process.env.CALLI_E2E_SHOTS_DIR) {
      await phonePage.screenshot({ animations: 'disabled', path: join(process.env.CALLI_E2E_SHOTS_DIR, `files-crumbs-phone-${colorScheme}.png`) });
    }
  } finally {
    await phoneCtx.close();
  }
});
}
