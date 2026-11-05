// Run `npm run build` from the repository root before capturing.
// Screenshots of the thread overview card, the one in the margin beside a conversation on a wide
// screen: the full card, a changes-only card, everything folded, the failed read, the narrow
// window that hides it, the demo workspace's own card, and a changes row whose name and folder
// are longer than the card has room for. Writes PNGs into shots/overview/.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, launchBrowser, openUi, api } from './harness.mjs';

const outDir = join(process.cwd(), 'shots', 'overview');
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const daemon = await startDaemon();
const browser = await launchBrowser();
const post = async (path, body) => {
  const res = await api(daemon, path, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
};
const get = async (path) => {
  const res = await api(daemon, path);
  if (!res.ok) throw new Error(`${path}: ${await res.text()}`);
  return res.json();
};
/** Idle that stays idle: the fake answers at once, but a member's result can start another turn
 * of the lead's right after the first one ends, and the shots want the conversation settled. */
const idle = async (threadId) => {
  for (let i = 0; i < 200; i++) {
    const t = await get(`/api/threads/${threadId}`);
    if (t.status !== 'running') {
      await sleep(400);
      if ((await get(`/api/threads/${threadId}`)).status !== 'running') return t;
    } else await sleep(100);
  }
  throw new Error(`thread ${threadId} is still running`);
};
/** A turn of a thread, waited out until it and whatever it triggered have settled. */
const turn = async (threadId, body) => {
  await post(`/api/threads/${threadId}/turns`, body);
  return idle(threadId);
};
/** Waits for the lead's automatic turn that hands a member's result over, so a turn sent after it
 * follows the handover instead of racing it. */
const relayed = async (threadId) => {
  for (let i = 0; i < 200; i++) {
    const events = await get(`/api/threads/${threadId}/events`);
    if (events.some((ev) => ev.type === 'turn.started' && String(ev.data?.text ?? '').includes('协作消息'))) {
      return idle(threadId);
    }
    await sleep(100);
  }
  throw new Error('the member result never reached the lead');
};

try {
  // The full card: a team of two (one waiting on the user, one reported back), a plan a third
  // done, an edited file, a written report and a chart. The mention turn turns collaboration on;
  // CALLI_COMMAND makes the fixture run the injected CLI as the lead, spawning real members.
  const spawn = (name, key, task) => `CALLI_COMMAND:${Buffer.from(JSON.stringify({
    args: ['spawn', '--agent', 'claude', '--name', name, '--message-file', '-', '--request-id', key],
    text: task,
  })).toString('base64')}`;
  const full = await post('/api/threads', { agent: 'claude', cwd: daemon.workdir, title: '周报与图表' });
  await turn(full.id, {
    text: '请审查接口文档',
    mentions: [{ id: 'claude', kind: 'agent', label: 'Claude Code', task: '复核报告里的数字' }],
  });
  // The waiting member only waits if members ask before they act; the team's default is full access.
  await post(`/api/threads/${full.id}/coordination`, { action: 'permission', permission: 'ask' });
  // This one asks for approval and waits on the person; its report says nothing of the protocol,
  // so the card keeps it among the rest rather than leading the line with it.
  await turn(full.id, { text: spawn('配色检查', 'colors', '核对图表中的颜色 approve') });
  // This one reports back; its result reaches the lead as a turn of the lead's own, waited out so
  // the work turn after it stays the thread's latest word (that is where the plan button looks).
  await turn(full.id, { text: spawn('文档审查', 'review', '检查接口与异常处理 CALLI_REPORT') });
  await relayed(full.id);
  await turn(full.id, { text: 'edit file, plan, make outputs' });
  // A card with nothing but changes: one edit, no plan, no pictures, no files. The warm-up turn
  // takes the daemon's one-time tools hint, so the turn that ends up on screen answers without
  // quoting it back.
  const edit = await post('/api/threads', { agent: 'claude', cwd: daemon.workdir, title: '只改一个文件' });
  await turn(edit.id, { text: '请审查接口文档' });
  await turn(edit.id, { text: 'edit file' });

  // The page's own look, not a hand on the DOM: a context whose system asks for dark, and for the
  // Nord palette a saved appearance read before the first paint.
  const contextFor = async (width, height, look = 'light') => {
    const made = await browser.newContext({
      viewport: { width, height },
      colorScheme: look === 'light' ? 'light' : 'dark',
    });
    if (look === 'nord-dark') {
      await made.addInitScript(
        (palette) => localStorage.setItem('calli.appearance', JSON.stringify({ mode: 'dark', palette })),
        'nord',
      );
    }
    return made;
  };
  const shot = (page, name) => page.screenshot({ path: join(outDir, `${name}.png`) });

  const open = async (context, threadId) => {
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await openUi(page, daemon);
    await page.locator('.thread-row', { hasText: (await get(`/api/threads/${threadId}`)).title }).click();
    return page;
  };
  /** The card needs the margin: on a 1440 screen the thread list is put away (Ctrl+Shift+S). */
  const openWithMargin = async (context, threadId) => {
    const page = await open(context, threadId);
    if (context._options.viewport.width === 1440) {
      await page.keyboard.press('Control+Shift+S');
      await page.locator('.app.sidebar-hidden').waitFor();
    }
    return page;
  };

  // The full card, desktop sizes, light dark and Nord dark. At 1440 the list is put away for the
  // margin to exist; at 1920 there is room beside the list as well.
  for (const [width, height] of [[1440, 900], [1920, 1080]]) {
    for (const look of ['light', 'dark', 'nord-dark']) {
      const context = await contextFor(width, height, look);
      const page = await openWithMargin(context, full.id);
      await page.locator('.thread-overview').waitFor();
      // The team group: both members in it, the waiting one first.
      await page.locator('.team-card-row', { hasText: '配色检查' }).waitFor();
      await page.locator('.team-card-row', { hasText: '文档审查' }).waitFor();
      await page.locator('.overview-picture img').first().waitFor();
      // The card owns the margin: the top bar gives up its team mark and its plan button.
      if (await page.locator('.topbar-agents').count()) throw new Error('topbar agents button still shown beside the card');
      if (await page.locator('.topbar-plan').count()) throw new Error('topbar plan button still shown beside the card');
      if (look === 'light' && width === 1440) {
        // The title's numbers sit over the rows' numbers: the + of the pair lines up.
        const lined = await page.evaluate(() => {
          const pair = (el) => el.querySelector('.overview-add')?.getBoundingClientRect();
          // The changes group's title is the one carrying numbers; the team's says words.
          const title = pair([...document.querySelectorAll('.overview-summary')].find((s) => s.querySelector('.overview-add')));
          const row = pair(document.querySelector('.overview-row .overview-nums'));
          return { title: title?.x ?? -1, row: row?.x ?? -1 };
        });
        if (lined.title < 0 || Math.abs(lined.title - lined.row) > 1) {
          throw new Error(`the title's + sits at ${lined.title}, the rows' at ${lined.row}`);
        }
      }
      await page.waitForTimeout(250);
      await shot(page, `full-${width}-${look}`);
      await page.close();
      await context.close();
    }
  }

  // A card with nothing but one change. The closing tag of an injected hint used to pass for a
  // file the answer handed over, which gave this card a files group it had no reason to have.
  for (const look of ['light', 'dark']) {
    const context = await contextFor(1440, 900, look);
    const page = await openWithMargin(context, edit.id);
    await page.locator('.thread-overview').waitFor();
    const card = await page.evaluate(() => ({
      rows: document.querySelectorAll('.overview-row').length,
      pictures: document.querySelectorAll('.overview-picture').length,
      groups: document.querySelectorAll('.overview-group').length,
    }));
    if (card.groups !== 1 || card.rows !== 1 || card.pictures !== 0) {
      throw new Error(`a one-edit thread shows ${JSON.stringify(card)}, wanted one group, one row, no pictures`);
    }
    await page.waitForTimeout(250);
    await shot(page, `changes-only-1440-${look}`);
    await page.close();
    await context.close();
  }

  // The full card with every group folded to its title line; the summaries stay.
  {
    const context = await contextFor(1440, 900, 'light');
    const page = await openWithMargin(context, full.id);
    await page.locator('.overview-picture img').first().waitFor();
    const toggles = page.locator('.overview-toggle');
    for (const i of Array.from({ length: await toggles.count() }, (_, i) => i)) await toggles.nth(i).click();
    await page.locator('.overview-group:not(.open) .overview-toggle').first().waitFor();
    await page.waitForTimeout(250);
    await shot(page, 'folded-1440-light');
    await page.close();
    await context.close();
  }

  // The read fails: the card says so in a line, apart from being empty. The team and the plan it
  // already had stay; the intercept is in place before the page ever asks.
  {
    const context = await contextFor(1440, 900, 'light');
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.route('**/api/threads/*/outputs', (route) => route.fulfill({ status: 500, body: 'nope' }));
    await openUi(page, daemon);
    await page.locator('.thread-row', { hasText: (await get(`/api/threads/${full.id}`)).title }).click();
    await page.keyboard.press('Control+Shift+S');
    await page.locator('.app.sidebar-hidden').waitFor();
    await page.locator('.overview-failed').waitFor();
    await shot(page, 'failed-1440-light');
    await page.close();
    await context.close();
  }

  // A window the margin no longer fits: the card goes, the top bar takes the team and the plan back.
  {
    const context = await contextFor(1100, 900, 'light');
    const page = await open(context, full.id);
    await page.locator('.thread-overview').waitFor({ state: 'detached' });
    await page.locator('.topbar-agents').waitFor();
    await page.locator('.topbar-plan').waitFor();
    await shot(page, 'narrow-1100-light');
    await page.close();
    await context.close();
  }

  // The demo workspace's own thread, whose card shows before any hub is connected: a new file, two
  // names longer than the card, and drawings rather than photos for thumbnails. At this width the
  // room is there, so a name that fits shows whole — the cut is the row's, not a fixed budget's.
  for (const [width, height, look] of [[1920, 1080, 'light'], [1920, 1080, 'dark']]) {
    const context = await contextFor(width, height, look);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(daemon.base + '/');
    await page.locator('.thread-row', { hasText: '设置页加深色模式' }).click();
    await page.locator('.thread-overview').waitFor();
    await page.locator('.overview-picture img').first().waitFor();
    const rows = await page.evaluate(() => [...document.querySelectorAll('.overview-row')].map((row) => {
      const stem = row.querySelector('.overview-stem');
      const ext = row.querySelector('.overview-ext');
      const dir = row.querySelector('.overview-dir');
      return {
        stem: stem?.textContent ?? '', ext: ext?.textContent ?? '',
        whole: stem ? stem.scrollWidth <= stem.clientWidth : false,
        extWhole: !ext || ext.scrollWidth <= ext.clientWidth,
        dirGaveWay: dir ? dir.scrollWidth > dir.clientWidth : false,
      };
    }));
    // No name is cut in JavaScript anymore: the row carries the whole name and cuts it itself.
    for (const r of rows) if (r.stem.includes('…') || r.stem.includes('…')) throw new Error(`"${r.stem}" was cut before the row`);
    // A row with room shows its name whole.
    for (const short of ['Settings', 'theme']) {
      if (!rows.some((r) => r.stem === short && r.whole)) throw new Error(`"${short}.tsx" is cut in a row with room for it`);
    }
    // The two names too long for the card cut in CSS alone, extension whole, folder gone first.
    const follow = rows.find((r) => r.stem === 'follow-system-color-scheme');
    if (!follow || follow.whole || !follow.extWhole || !follow.dirGaveWay) throw new Error(`the long name row reads ${JSON.stringify(follow)}`);
    if (look === 'light') console.log(`whole at ${width}: ${rows.filter((r) => r.whole).length}/${rows.length} names fit uncut`);
    await page.waitForTimeout(250);
    await shot(page, `demo-${width}-${look}`);
    await page.close();
    await context.close();
  }

  // The wrapup thread's card: each member's state read from the word its own report ended with,
  // lined up so the one needing the person comes first — ahead of the one that failed. The fixture
  // cannot write the protocol (its reports are fixed), so this card is where the order shows.
  {
    const context = await contextFor(1440, 900, 'light');
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(daemon.base + '/');
    await page.locator('.thread-row', { hasText: '上线前收尾' }).click();
    await page.keyboard.press('Control+Shift+S');
    await page.locator('.app.sidebar-hidden').waitFor();
    await page.locator('.team-card-row', { hasText: '深色核对' }).waitFor();
    const team = await page.evaluate(() => ({
      order: [...document.querySelectorAll('.team-card-row .team-card-line strong')].map((el) => el.textContent),
      states: [...document.querySelectorAll('.team-card-row .team-card-state')].map((el) => `${el.className.split(' ')[1]}=${el.textContent}`),
      title: document.querySelector('.overview-group .overview-summary')?.textContent ?? '',
    }));
    if (team.order.join(',') !== '深色核对,统计补齐,接口审查') throw new Error(`members line up as ${team.order.join(',')}`);
    if (team.states.join(',') !== 'need=需要你,failed=失败,review=待验收') throw new Error(`their words are ${team.states.join(',')}`);
    if (team.title !== '1 需要你') throw new Error(`the team's title says "${team.title}"`);
    await page.waitForTimeout(250);
    await shot(page, 'demo-wrapup-1440-light');
    await page.close();
    await context.close();
  }

  // The long row on its own: the cut is made against the row's own width — the folder gives way
  // first, from the left, then the name's stem folds, its extension whole on the end — the new
  // file in quiet words, the pair only what it added, the drawing whole on its background.
  {
    const context = await contextFor(1440, 900, 'light');
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(daemon.base + '/');
    await page.locator('.thread-row', { hasText: '设置页加深色模式' }).click();
    await page.keyboard.press('Control+Shift+S');
    await page.locator('.app.sidebar-hidden').waitFor();
    await page.locator('.overview-row', { hasText: '新建' }).waitFor();
    const said = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.overview-row')].find((el) => el.textContent.includes('新建'));
      const stem = row.querySelector('.overview-stem');
      const ext = row.querySelector('.overview-ext');
      const dir = row.querySelector('.overview-dir');
      const vector = document.querySelector('.overview-picture.vector img');
      return {
        stem: stem?.textContent ?? '',
        // The stem's own ellipsis is the whole cut: nothing overflows its box a second time.
        stemCut: stem ? stem.scrollWidth > stem.clientWidth : true,
        ext: ext?.textContent ?? null,
        extWhole: !ext || (ext.scrollWidth <= ext.clientWidth && getComputedStyle(ext).flexGrow === '0'),
        dir: dir?.textContent ?? '',
        dirShown: dir ? dir.getBoundingClientRect().width : 0,
        // The folder yields before the name: a folded stem means a folded folder.
        dirGaveWay: dir ? dir.scrollWidth > dir.clientWidth : false,
        nums: row.querySelector('.overview-nums')?.textContent ?? '',
        fit: vector ? getComputedStyle(vector).objectFit : '',
        padding: vector ? getComputedStyle(vector.parentElement).padding : '',
      };
    });
    if (!said.stem || said.ext !== '.tsx') throw new Error(`the long name shows as "${said.stem}${said.ext ?? ''}"`);
    if (!said.stemCut) throw new Error(`"${said.stem}" fits at 1440, wanted the row too narrow for it`);
    if (!said.extWhole) throw new Error('the extension was squeezed along with the stem');
    if (!said.dirGaveWay) throw new Error(`the folder "${said.dir}" kept itself whole while the name folded`);
    if (said.dirShown < 24) throw new Error(`the folder is ${said.dirShown} wide, under the few characters it may not go`);
    if (said.nums !== '+34') throw new Error(`a new file's pair says "${said.nums}", wanted only what it added`);
    if (said.fit !== 'contain') throw new Error(`a drawing fills its square with ${said.fit}`);
    if (said.padding !== '4px') throw new Error(`a drawing has ${said.padding} around it, wanted 4px`);
    await page.waitForTimeout(250);
    await shot(page, 'long-name-1440-light');
    await page.close();
    await context.close();
  }

  // The plan under way: a finished step, the one being worked on and one not started, apart in the
  // card the way they are in the panel. The turn is still open — that is what keeps one step live.
  {
    const context = await contextFor(1440, 900, 'light');
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(daemon.base + '/');
    await page.locator('.thread-row', { hasText: '修复商品列表滚动跳动' }).click();
    await page.keyboard.press('Control+Shift+S');
    await page.locator('.app.sidebar-hidden').waitFor();
    await page.locator('.overview-plan .plan-entry.active', { hasText: 'e2e' }).waitFor();
    const states = await page.evaluate(() => ({
      done: document.querySelectorAll('.overview-plan .plan-entry.completed').length,
      active: document.querySelectorAll('.overview-plan .plan-entry.active').length,
      pending: document.querySelectorAll('.overview-plan .plan-entry:not(.completed):not(.active)').length,
    }));
    if (states.done !== 1 || states.active !== 1 || states.pending !== 1) {
      throw new Error(`the plan shows ${JSON.stringify(states)}, wanted one of each`);
    }
    await page.waitForTimeout(250);
    await shot(page, 'plan-states-1440-light');
    await page.close();
    await context.close();
  }

  console.log(`shots written to ${outDir}`);
} finally {
  await browser.close();
  await daemon.stop();
}
