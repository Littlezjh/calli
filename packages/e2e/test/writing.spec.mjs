import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { startDaemon, openUi, api, launchBrowser } from '../harness.mjs';

let daemon, browser;
const shots = process.env.RAH_E2E_SHOTS_DIR;
const prefix = process.env.RAH_E2E_SHOTS_PREFIX ?? 'writing';
before(async () => {
  daemon = await startDaemon();
  browser = await launchBrowser();
  if (shots) mkdirSync(shots, { recursive: true });
});
after(async () => { await browser?.close(); await daemon?.stop(); });

/** A small solid PNG, so the preview has a real picture to load. */
function png(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows.set([r, g, b], y * (width * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const NAME = '思考是人类的事情';
const BODY = `# ${NAME}

我好久没真正自己思考写东西了。现在很多时候，是想一句话，然后让 AI 帮我把一篇文章写出来。

今天写 PR 的时候不一样。我得真的去想，为什么要这样写。【待补：写到哪一句时发现想法变了】

## AI 可以做什么

观点得是我的，无论它多偏激。

\`\`\`mermaid
flowchart LR
  A[采访 · 提问] --> M((我的思考))
  B[资料 · 比喻] --> M
  M --> C[我的文章]
\`\`\`

![书桌](${NAME}/desk.png)
`;

/** A thread whose folder has a body under writing/, and a picture beside it. */
async function setup(title, cwd) {
  mkdirSync(join(cwd, 'writing', NAME), { recursive: true });
  const file = join(cwd, 'writing', `${NAME}.md`);
  writeFileSync(file, BODY);
  writeFileSync(join(cwd, 'writing', NAME, 'desk.png'), png(240, 120, [196, 160, 112]));
  const res = await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd, model: 'fake/plain', title, permissionMode: 'full_access' }) });
  assert.equal(res.status, 201);
  return { thread: await res.json(), file };
}

const view = async (id) => (await api(daemon, `/api/threads/${id}`)).json();
const waitFor = async (check, what) => {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await check();
    if (value) return value;
    assert.ok(Date.now() < deadline, what);
    await new Promise((r) => setTimeout(r, 50));
  }
};
const waitIdle = (id) => waitFor(async () => { const v = await view(id); return v.status !== 'running' && v; }, 'turn finished');

const select = async (page, title, mobile) => {
  await openUi(page, daemon);
  if (mobile) await page.locator('.menu-btn').click();
  await page.locator('.thread-title', { hasText: title }).first().click();
};
const send = async (page, text) => {
  await page.locator('.composer textarea').first().fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.composer textarea')?.value === '');
};
const fitsWidth = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test('writing mode on desktop: start, change stage, preview, edit and save, conflicts, end', { timeout: 240000 }, async () => {
  for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme });
    try {
      const page = await context.newPage();
      const shot = async (name) => shots && page.screenshot({ path: join(shots, `${prefix}-${name}-desktop-${colorScheme}.png`), animations: 'disabled' });
      const title = `写作 桌面 ${colorScheme}`;
      const cwd = join(daemon.workdir, `desk-${colorScheme}`);
      const { thread, file } = await setup(title, cwd);
      await select(page, title, false);

      // The add menu: writing mode sits with the modes, one click turns it on.
      await page.getByRole('button', { name: '添加与模式', exact: true }).click();
      const choice = page.getByRole('option', { name: /^写作模式/ });
      assert.equal(await choice.getAttribute('aria-checked'), 'false');
      await shot('menu');
      await choice.click();
      const bar = page.locator('.writing-bar');
      await bar.waitFor();
      assert.equal((await view(thread.id)).writing?.stage, 'draft');
      // The daemon may name an existing body at once; until it has one the bar says so.
      await bar.locator('.writing-file').waitFor();
      await page.locator('.composer textarea[placeholder="继续说，或者让 agent 补哪一段…"]').waitFor();

      // After a turn the daemon names the newest body under writing/.
      await send(page, '今天想写一篇关于思考的文章');
      await waitIdle(thread.id);
      await waitFor(async () => (await view(thread.id)).writing?.file, 'the body is named after the turn');
      const link = bar.getByRole('button', { name: `打开正文 ${NAME}.md`, exact: true });
      await link.waitFor();

      // Stages: the current one is marked; a click moves it.
      assert.equal(await bar.locator('.writing-stage.current').textContent(), '初稿');
      await bar.getByRole('button', { name: '二稿', exact: true }).click();
      await bar.locator('.writing-stage.current', { hasText: '二稿' }).waitFor();
      assert.equal((await view(thread.id)).writing.stage, 'second');

      // The body opens in the file panel: the diagram is drawn and the relative picture loads.
      await link.click();
      const panel = page.locator('.files-panel');
      await panel.locator('.files-markdown h1', { hasText: NAME }).waitFor();
      await panel.locator('.files-diagram svg').waitFor({ timeout: 20_000 });
      const picture = panel.locator('.files-inline-picture img');
      await picture.waitFor();
      await page.waitForFunction(() => (document.querySelector('.files-inline-picture img')?.naturalWidth ?? 0) === 240);
      await shot('preview');
      // A click on the diagram enlarges it.
      await panel.locator('.files-diagram').click();
      await page.locator('.lightbox').waitFor();
      await page.keyboard.press('Escape');
      await page.locator('.lightbox').waitFor({ state: 'detached' });

      // Edit: a plain page of text, saved with Ctrl+S.
      await panel.getByRole('button', { name: '编辑', exact: true }).click();
      const editor = panel.getByRole('textbox', { name: '正文', exact: true });
      await editor.waitFor();
      assert.equal(await editor.inputValue(), BODY);
      assert.equal(await panel.locator('.files-num').count(), 0, 'no line numbers in the editor');
      const edited = BODY.replace('【待补：写到哪一句时发现想法变了】', '其实那一刻是写到「为什么不直接复用旧接口」的时候。');
      await editor.fill(edited);
      await panel.getByText('未保存', { exact: true }).waitFor();
      await shot('edit');

      // Unsaved text outlives a reload.
      await page.waitForTimeout(600);
      await page.reload();
      await page.locator('.thread-title', { hasText: title }).first().click();
      await page.locator('.writing-bar').getByRole('button', { name: `打开正文 ${NAME}.md`, exact: true }).click();
      await panel.getByRole('textbox', { name: '正文', exact: true }).waitFor();
      assert.equal(await panel.getByRole('textbox', { name: '正文', exact: true }).inputValue(), edited, 'the draft came back after reload');
      await panel.getByRole('textbox', { name: '正文', exact: true }).focus();
      await page.keyboard.press('Control+s');
      await panel.getByText('未保存', { exact: true }).waitFor({ state: 'detached' });
      assert.equal(readFileSync(file, 'utf8'), edited);

      // The agent changes the body meanwhile: the save is refused, the text stays, overwrite wins.
      const mine = `${edited}\n我自己加的一段。\n`;
      await editor.fill(mine);
      writeFileSync(file, `${edited}\n〔补〕agent 补的一段。\n`);
      await panel.getByRole('button', { name: '保存', exact: true }).click();
      const conflict = panel.locator('.writing-conflict');
      await conflict.getByText('正文被改过。你写的还在下面，可以先复制。', { exact: true }).waitFor();
      assert.equal(await editor.inputValue(), mine, 'what was typed stays in the box');
      await shot('conflict');
      await conflict.getByRole('button', { name: '仍然覆盖', exact: true }).click();
      await conflict.waitFor({ state: 'detached' });
      assert.equal(readFileSync(file, 'utf8'), mine);

      // Again, and this time load the new version instead.
      await editor.fill(`${mine}再来一段。\n`);
      const theirs = `${mine}〔补〕又补了一段。\n`;
      writeFileSync(file, theirs);
      await page.keyboard.press('Control+s');
      await conflict.waitFor();
      await conflict.getByRole('button', { name: '载入新版本', exact: true }).click();
      await conflict.waitFor({ state: 'detached' });
      assert.equal(await editor.inputValue(), theirs);

      // Leaving with unsaved text asks first.
      await editor.fill(`${theirs}没保存的。\n`);
      await panel.getByRole('button', { name: '取消', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '放弃没保存的修改？' });
      await dialog.waitFor();
      await dialog.getByRole('button', { name: '放弃修改', exact: true }).click();
      await editor.waitFor({ state: 'detached' });
      assert.equal(readFileSync(file, 'utf8'), theirs, 'discarding does not write');
      await panel.getByRole('button', { name: '编辑', exact: true }).waitFor();

      // End: the bar goes, the body stays.
      await page.locator('.writing-bar').getByRole('button', { name: '结束', exact: true }).click();
      await page.locator('.writing-bar').waitFor({ state: 'detached' });
      assert.equal((await view(thread.id)).writing, null);
      assert.equal(readFileSync(file, 'utf8'), theirs);
      assert.ok(await fitsWidth(page));
    } finally { await context.close(); }
  }
});

test('writing mode on a phone: folded bar, stage picker, full-screen editor', { timeout: 180000 }, async () => {
  for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme });
    try {
      const page = await context.newPage();
      const shot = async (name) => shots && page.screenshot({ path: join(shots, `${prefix}-${name}-phone-${colorScheme}.png`), animations: 'disabled' });
      const title = `写作 手机 ${colorScheme}`;
      const cwd = join(daemon.workdir, `phone-${colorScheme}`);
      // A new thread, before any article exists: the bar stays one line, not a tall blank card.
      await openUi(page, daemon);
      await page.goto(daemon.base + '/#/new');
      await page.getByRole('button', { name: '添加与模式', exact: true }).click();
      await page.getByRole('menuitemcheckbox', { name: /^写作模式/ }).click();
      const fresh = page.locator('.writing-bar.compact');
      await fresh.waitFor();
      assert.ok((await fresh.boundingBox()).height < 60, `the bar on a new thread is ${(await fresh.boundingBox()).height}px tall`);
      await shot('new');
      await page.getByRole('button', { name: '添加与模式', exact: true }).click();
      await page.getByRole('menuitemcheckbox', { name: /^写作模式/ }).click();
      await fresh.waitFor({ state: 'detached' });

      const { thread, file } = await setup(title, cwd);
      await select(page, title, true);

      await page.getByRole('button', { name: '添加与模式', exact: true }).click();
      await shot('menu');
      await page.getByRole('menuitemcheckbox', { name: /^写作模式/ }).click();
      const bar = page.locator('.writing-bar.compact');
      await bar.waitFor();
      await send(page, '开始写');
      await waitIdle(thread.id);
      await bar.getByRole('button', { name: `打开正文 ${NAME}.md`, exact: true }).waitFor();
      await shot('bar');
      assert.ok(await fitsWidth(page));

      // The stage is a picker on a phone.
      await bar.locator('.writing-stage-pick').click();
      await page.getByRole('menuitemradio', { name: '三稿' }).waitFor();
      await shot('stages');
      await page.getByRole('menuitemradio', { name: '三稿' }).click();
      await bar.locator('.writing-stage-pick', { hasText: '三稿' }).waitFor();
      assert.equal((await view(thread.id)).writing.stage, 'third');

      // The body: preview, then a full-screen editor.
      await bar.getByRole('button', { name: `打开正文 ${NAME}.md`, exact: true }).click();
      const panel = page.locator('.files-panel.phone');
      await panel.locator('.files-diagram svg').waitFor({ timeout: 20_000 });
      await page.waitForFunction(() => (document.querySelector('.files-inline-picture img')?.naturalWidth ?? 0) === 240);
      await shot('preview');
      await panel.getByRole('button', { name: '编辑', exact: true }).click();
      const editor = panel.getByRole('textbox', { name: '正文', exact: true });
      await editor.fill(`${BODY}\n手机上写的一段。\n`);
      await panel.getByText('未保存', { exact: true }).waitFor();
      const box = await editor.boundingBox();
      assert.ok(box && box.width >= 380, 'the editor fills the screen');
      await shot('edit');
      await panel.getByRole('button', { name: '保存', exact: true }).click();
      await panel.getByText('未保存', { exact: true }).waitFor({ state: 'detached' });
      assert.equal(readFileSync(file, 'utf8'), `${BODY}\n手机上写的一段。\n`);
      assert.ok(await fitsWidth(page));
    } finally { await context.close(); }
  }
});
