import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, openUi, launchBrowser, repoRoot } from '../harness.mjs';

const REPLY = [
  '以下是配图核对清单（含 `<br/>` 表格与 GFM HTML）：',
  '',
  '| 优先级 | 图位 | 状态 | 说明 |',
  '| --- | --- | --- | --- |',
  '| **P2**<br/>可选补/改 | **发展历程（缺图）**<br/>**图 1：产品架构**<br/>**图 9：当下核心问题** | 能用，按需升级 | · **发展历程**：目前无画板；<br/>· **图 1 产品架构**：第一排第 3 格留了空框位；<br/>· **图 9 当下核心问题**：当前是极简三层目标图。 |',
  '',
  '快捷键 <kbd>⌘</kbd>+<kbd>K</kbd>，分子式 H<sub>2</sub>O，次方 x<sup>2</sup>，<mark>高亮标注</mark>，<u>下划线</u>。',
  '',
  '行内代码 `<br/>` 和 `<details>` 原样保留；占位符 <user_id> 与 Promise<T> 也不被吞掉。',
  '',
  '<details>',
  '<summary>展开查看详细说明</summary>',
  '',
  '折叠区块内的正文，支持 **加粗** 和 `code`。<script>window.__xss=1</script><img src="https://example.com/a.png" onerror="window.__xss=2" />',
  '</details>',
].join('\n');

test('GFM allowlisted HTML renders cleanly in chat and file preview while sanitizing unsafe markup', { timeout: 120_000 }, async () => {
  let daemon, browser;
  try {
    daemon = await startDaemon({}, { agents: [{ id: 'pi', adapter: 'pi', command: ['fake-pi'] }] });
    const { Store } = await import(join(repoRoot, 'daemon', 'dist', 'store.js'));
    const localFile = join(daemon.workdir, 'notes.md');
    writeFileSync(localFile, `# 配图核对\n\n${REPLY}\n`);
    const store = new Store(daemon.dataDir);
    try {
      store.createThread({ id: 'md-html', agent: 'pi', cwd: daemon.workdir, title: 'Markdown HTML 验收', permissionMode: 'auto_edit', model: null, effort: null });
      store.appendEvent('md-html', 'reply', 'turn.started', { text: '给我一份配图核对表', imported: true });
      store.appendEvent('md-html', 'reply', 'message.delta', { text: `${REPLY}\n\n查看文件：[notes.md](${localFile})` });
      store.appendEvent('md-html', 'reply', 'turn.done', { stopReason: 'end_turn', imported: true });
    } finally { store.close(); }

    browser = await launchBrowser();
    for (const mobile of [false, true]) for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
        isMobile: mobile,
        hasTouch: mobile,
        colorScheme,
      });
      try {
        await context.addInitScript((scheme) => {
          localStorage.setItem('calli_onboard_dismissed', '1');
          localStorage.setItem('calli.appearance', JSON.stringify({ mode: scheme, palette: 'paper' }));
        }, colorScheme);
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await openUi(page, daemon);
        await page.goto(`${daemon.base}/#/thread/md-html`);

        const answer = page.locator('.row.assistant .markdown');
        await answer.locator('table').waitFor({ state: 'visible' });

        const checks = await page.evaluate(() => {
          const md = document.querySelector('.row.assistant .markdown');
          const text = md?.textContent ?? '';
          const doc = document.scrollingElement ?? document.documentElement;
          return {
            brCount: md?.querySelectorAll('td br').length ?? 0,
            kbdCount: md?.querySelectorAll('kbd').length ?? 0,
            subCount: md?.querySelectorAll('sub').length ?? 0,
            supCount: md?.querySelectorAll('sup').length ?? 0,
            markCount: md?.querySelectorAll('mark').length ?? 0,
            uCount: md?.querySelectorAll('u').length ?? 0,
            detailsCount: md?.querySelectorAll('details').length ?? 0,
            scriptCount: md?.querySelectorAll('script').length ?? 0,
            hasPlaceholder: text.includes('<user_id>') && text.includes('Promise<T>'),
            hasInlineCodeBr: Array.from(md?.querySelectorAll('code') ?? []).some(el => el.textContent === '<br/>'),
            xss: window.__xss ?? null,
            overflow: doc.scrollWidth > doc.clientWidth + 1,
          };
        });
        assert.equal(checks.brCount, 5);
        assert.equal(checks.kbdCount, 2);
        assert.equal(checks.subCount, 1);
        assert.equal(checks.supCount, 1);
        assert.equal(checks.markCount, 1);
        assert.equal(checks.uCount, 1);
        assert.equal(checks.detailsCount, 1);
        assert.equal(checks.scriptCount, 0);
        assert.equal(checks.hasPlaceholder, true);
        assert.equal(checks.hasInlineCodeBr, true);
        assert.equal(checks.xss, null);
        assert.equal(checks.overflow, false, `${mobile ? 'phone' : 'desktop'}-${colorScheme}: horizontal overflow`);

        await answer.locator('details > summary').click();
        assert.equal(await answer.locator('details').getAttribute('open'), '');

        if (process.env.CALLI_E2E_SHOTS_DIR) {
          mkdirSync(process.env.CALLI_E2E_SHOTS_DIR, { recursive: true });
          await page.screenshot({ animations: 'disabled', path: join(process.env.CALLI_E2E_SHOTS_DIR, `markdown-html-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`) });
        }

        // Open the same Markdown in FilesPanel via its local file link.
        await answer.getByRole('button', { name: 'notes.md', exact: true }).click();
        const fileMd = page.locator('.files-markdown');
        await fileMd.locator('table').waitFor({ state: 'visible' });
        const fileChecks = await page.evaluate(() => {
          const md = document.querySelector('.files-markdown');
          return {
            brCount: md?.querySelectorAll('td br').length ?? 0,
            kbdCount: md?.querySelectorAll('kbd').length ?? 0,
            detailsCount: md?.querySelectorAll('details').length ?? 0,
            scriptCount: md?.querySelectorAll('script').length ?? 0,
          };
        });
        assert.equal(fileChecks.brCount, 5);
        assert.equal(fileChecks.kbdCount, 2);
        assert.equal(fileChecks.detailsCount, 1);
        assert.equal(fileChecks.scriptCount, 0);

        if (process.env.CALLI_E2E_SHOTS_DIR && !mobile && colorScheme === 'light') {
          await page.screenshot({ animations: 'disabled', path: join(process.env.CALLI_E2E_SHOTS_DIR, 'markdown-html-files-desktop-light.png') });
        }

        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
  } finally {
    await browser?.close();
    await daemon?.stop();
  }
});
