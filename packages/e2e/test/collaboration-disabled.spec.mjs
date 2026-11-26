import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startDaemon, launchBrowser, openUi, api, linkDaemon, repoRoot } from '../harness.mjs';

let daemon, browser;
// Each spec owns its hub and fake CLIs; only wait-first prompts take the finite delayed path.
before(async t => {
  daemon = await startDaemon({
    CALLI_AGENTS_JSON: JSON.stringify({ agents: [
      { id: 'pi', adapter: 'pi', command: ['fake-pi'] },
      { id: 'claude', adapter: 'claude', label: 'Claude Code', command: ['fake-claude'] },
      { id: 'codex', adapter: 'codex', command: [process.execPath, join(repoRoot, 'daemon/test/fixtures/fake-codex.mjs')] },
    ] }),
    FAKE_PI_FIRST_OUTPUT_DELAY_MS: '20000',
  });
  t.diagnostic(`Fake hub PID ${daemon.pid}, port ${new URL(daemon.base).port}, data ${daemon.dataDir}, work ${daemon.workdir}`);
  await post(daemon, '/api/extensions/voice/install', { granted: ['voice.control'] });
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); await daemon?.stop(); });

async function read(hub, path) {
  const response = await api(hub, path);
  assert.ok(response.ok, `${path}: ${await response.clone().text()}`);
  return response.json();
}

async function post(hub, path, body) {
  const response = await api(hub, path, { method: 'POST', body: JSON.stringify(body) });
  assert.ok(response.ok, `${path}: ${await response.clone().text()}`);
  return response.status === 204 ? null : response.json();
}

async function until(readState, matches, description, timeout = 15000) {
  let value;
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    value = await readState();
    if (matches(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`${description}: ${JSON.stringify(value)}`);
}

async function realMembers(hub, title, agent = 'pi') {
  // Spawn native collaboration seats through the injected CLI, never through a fake roster.
  const root = await post(hub, '/api/threads', { agent: 'pi', cwd: hub.workdir, title });
  await post(hub, `/api/threads/${root.id}/coordination`, {});
  for (const [index, name] of ['Target_seat', 'Sibling_seat'].entries()) {
    const directive = Buffer.from(JSON.stringify({ args: ['spawn', '--agent', agent, '--name', name, '--message-file', '-', '--request-id', `thread-switch-${root.id}-${index}`], text: 'done' })).toString('base64');
    await post(hub, `/api/threads/${root.id}/turns`, { text: `CALLI_COMMAND:${directive}`, queue: true });
  }
  const initial = await until(() => read(hub, `/api/threads/${root.id}/coordination`), value => value?.members.length === 2
    && value.members.every(member => member.thread?.status === 'idle') && value.messages.every(message => !['queued', 'running'].includes(message.state)), 'fake members did not settle');
  const lead = await until(() => read(hub, `/api/threads/${root.id}`), value => value.status === 'idle' && !value.queued.length, 'fake lead did not settle');
  const seat = initial.members.find(member => member.name === 'Target_seat');
  const otherSeat = initial.members.find(member => member.name === 'Sibling_seat');
  assert.ok(seat && otherSeat);
  const [member, sibling] = await Promise.all([seat.id, otherSeat.id].map(id => read(hub, `/api/threads/${id}`)));
  assert.equal(lead.coordination?.rootId, lead.id);
  for (const thread of [member, sibling]) {
    assert.equal(thread.agent, agent);
    assert.equal(thread.disabled, false);
    assert.equal(thread.coordination?.rootId, lead.id);
    assert.notEqual(thread.id, lead.id);
    assert.notEqual(thread.coordination?.retired, true);
  }
  return { root: lead, member, sibling };
}

async function contextFor(phone, colorScheme) {
  const context = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    isMobile: phone, hasTouch: phone, colorScheme, locale: 'en-US',
  });
  await context.addInitScript(token => {
    localStorage.setItem('calli.token', token);
    localStorage.setItem('calli.locale', 'en');
  }, daemon.token);
  return context;
}

async function openThread(page, thread, machine = null) {
  await page.evaluate(({ id, machine }) => {
    location.hash = `#/thread/${encodeURIComponent(id)}${machine === null ? '' : `?machine=${encodeURIComponent(machine)}`}`;
  }, { id: thread.id, machine });
  // A repeated title can precede link resolution; wait for navigation to finish and close the drawer.
  await page.waitForFunction(() => !location.hash.startsWith('#/thread/') && !document.documentElement.classList.contains('list-open'));
  await page.locator('.topbar-title', { hasText: thread.title }).waitFor();
  await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
}

async function openCollaboration(page) {
  await page.getByRole('button', { name: 'Add and modes', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Collaborate', exact: true })
    .or(page.getByRole('option', { name: 'Collaborate', exact: true })).click();
  await page.locator('.coord-picker-panel').waitFor();
}

async function openReferences(page) {
  await page.locator('.composer').getByRole('button', { name: 'Reference a chat or folder', exact: true }).click();
  await page.locator('.reference-picker').waitFor();
  await page.getByRole('tab', { name: /^Agents/ }).click();
}

const threadRow = (page, thread) => page.locator('.sidebar .thread-row').filter({
  has: page.getByText(thread.title.replace(/(?:（接手）)+$/, ''), { exact: true }),
});
const threadMenu = (page, thread) => page.getByRole('menu', { name: thread.title, exact: true });
const threadPath = (thread, machine = null) => `${machine === null ? '/api' : `/api/hosts/${machine}/proxy`}/threads/${thread.id}`;

async function showList(page, phone) {
  if (phone && !await page.evaluate(() => document.documentElement.classList.contains('list-open'))) {
    // A member's back button goes to its lead, whose real list button then opens the phone drawer.
    const backToLead = page.getByRole('button', { name: 'Back to lead thread', exact: true });
    if (await backToLead.isVisible()) await backToLead.click();
    await page.getByRole('button', { name: 'Open thread list', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.classList.contains('list-open'));
  }
  await page.locator('.sidebar-inner').waitFor();
}

const teamGroup = (page, root) => page.locator('.sidebar .team-group').filter({
  has: page.getByText(root.title, { exact: true }),
});
const teamMemberRow = (page, root, member) => teamGroup(page, root).locator(`.handover-member[title=${JSON.stringify(member.title)}]`);

async function expandTeam(page, root) {
  const toggle = teamGroup(page, root).locator(':scope > .handover-toggle');
  await toggle.waitFor();
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}

async function openListMenu(page, thread, row, phone, keyboard = false, root = null) {
  await showList(page, phone);
  if (root) await expandTeam(page, root);
  await row.scrollIntoViewIfNeeded();
  if (keyboard) {
    // Members are native buttons, while ordinary phone rows hide their separate more button.
    const memberButton = await row.evaluate(element => element.matches('button.handover-member'));
    const opener = memberButton ? row : row.locator(phone ? '.thread-item' : '.row-more');
    await opener.waitFor();
    await opener.focus();
    assert.equal(await opener.evaluate(element => document.activeElement === element), true, 'the real row menu opener receives keyboard focus');
    await page.keyboard.press(memberButton || phone ? 'Shift+F10' : 'Enter');
  } else await row.click({ button: 'right', position: { x: 60, y: 18 } });
  await threadMenu(page, thread).waitFor();
}

async function assertListMenu(page, thread, disabled = null) {
  const menu = threadMenu(page, thread);
  const id = disabled === null ? null : disabled ? 'enable' : 'disable';
  const required = ['pin', 'unread', 'rename', 'copy-link', 'section', 'todo', ...(id ? [id] : []), 'archive', 'delete'];
  const ids = await menu.locator(':scope > .menu-cell > [data-menu-id]').evaluateAll(items => items.map(item => item.dataset.menuId));
  assert.deepEqual(ids.filter(item => required.includes(item)), required, 'the original list actions keep their order');
  assert.equal(await menu.locator('[data-menu-id="disable"], [data-menu-id="enable"]').count(), id ? 1 : 0, 'only current collaboration members have a switch');
  if (id) {
    assert.equal(await menu.locator(`[data-menu-id="${id}"]`).innerText(), disabled ? 'Enable' : 'Disable');
    assert.equal(await menu.locator(`[data-menu-id="${id}"]`).evaluate(item => item.parentElement.nextElementSibling?.getAttribute('role')), 'separator');
  }
  const bounds = await menu.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1, 'the complete row menu fits the viewport');
}

async function chooseSwitch(page, hub, thread, disabled, machine = null, keyboard = false) {
  const path = threadPath(thread, machine);
  // Mark-read PATCHes can race this action; wait for the switch payload on the exact machine and row.
  const saving = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'PATCH' && response.request().postDataJSON()?.disabled === disabled);
  const item = threadMenu(page, thread).getByRole('menuitem', { name: disabled ? 'Disable' : 'Enable', exact: true });
  if (keyboard) { await item.focus(); await page.keyboard.press('Enter'); }
  else await item.click();
  const response = await saving;
  assert.equal(response.status(), 200, await response.text());
  assert.deepEqual(response.request().postDataJSON(), { disabled });
  const changed = await response.json();
  assert.equal(changed.id, thread.id, 'the menu changes only its actual row identity');
  assert.equal(changed.disabled, disabled);
  await threadMenu(page, thread).waitFor({ state: 'detached' });
  await until(() => read(hub, `/api/threads/${thread.id}`), value => value.disabled === disabled, 'the single-thread switch was not saved');
}

async function choosePin(page, thread, pinned, keyboard = false) {
  // A main Agent has no collaboration switch; Pin still proves which real chain row the menu owns.
  const saving = page.waitForResponse(response => new URL(response.url()).pathname === threadPath(thread) && response.request().method() === 'PATCH' && response.request().postDataJSON()?.pinned === pinned);
  const item = threadMenu(page, thread).getByRole('menuitem', { name: pinned ? 'Pin' : 'Unpin', exact: true });
  if (keyboard) { await item.focus(); await page.keyboard.press('Enter'); }
  else await item.click();
  const response = await saving;
  assert.equal(response.status(), 200, await response.text());
  assert.deepEqual(response.request().postDataJSON(), { pinned });
  const changed = await response.json();
  assert.equal(changed.id, thread.id, 'the chain menu patches its actual row identity');
  assert.equal(changed.pinned, pinned);
  await threadMenu(page, thread).waitFor({ state: 'detached' });
  await until(() => read(daemon, `/api/threads/${thread.id}`), value => value.pinned === pinned, 'the chain row pin was not saved');
}

async function sendManually(page, hub, thread, text, machine = null, queue = false) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  // The optional assistant install notice overlaps phone Send; dismiss it through its actual control.
  const closeAssistant = page.locator('.pet-away .pet-install-close');
  if (await closeAssistant.isVisible()) { await closeAssistant.click(); await page.locator('.pet-away').waitFor({ state: 'detached' }); }
  const [response] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === `${threadPath(thread, machine)}/turns` && response.request().method() === 'POST'),
    page.locator('.composer').getByRole('button', { name: queue ? 'Queue' : 'Send', exact: true }).click(),
  ]);
  assert.equal(response.status(), 202, await response.text());
  assert.equal(response.request().postDataJSON().text, text);
  if (queue) assert.equal(response.request().postDataJSON().queue, true);
  const sent = await response.json();
  if (!queue) {
    await page.locator(`.row.user[data-turn="${sent.turnId}"]`).waitFor();
    await until(() => read(hub, `/api/threads/${thread.id}`), value => value.status === 'idle' && !value.queued.length, 'the manual fake-agent turn did not finish');
  }
  return sent;
}

for (const phone of [false, true]) for (const colorScheme of ['light', 'dark']) {
  test(`only the sidebar member switch preserves chat and drafts: ${phone ? 'phone' : 'desktop'} ${colorScheme}`, { timeout: 90000 }, async () => {
    // A real Pi member can leave collaboration without locking chat or changing its instance peers.
    const { root, member, sibling } = await realMembers(daemon, `Thread switch ${phone} ${colorScheme}`);
    const other = await post(daemon, '/api/threads', { agent: 'pi', cwd: daemon.workdir, title: `Same instance ${phone} ${colorScheme}` });
    assert.equal(root.disabled, false);
    assert.equal(other.disabled, false);
    assert.equal(other.coordination, undefined);
    const historyText = 'A completed conversation remains readable.';
    const historical = await post(daemon, `/api/threads/${member.id}/turns`, { text: historyText });
    await until(() => read(daemon, `/api/threads/${member.id}`), value => value.status === 'idle', 'the initial history did not finish');
    const context = await contextFor(phone, colorScheme);
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      const mutations = [];
      page.on('request', request => {
        if (['PATCH', 'POST', 'DELETE'].includes(request.method())) mutations.push({ path: new URL(request.url()).pathname, method: request.method(), body: request.postDataJSON() });
      });
      await openUi(page, daemon);
      await openThread(page, member);
      const input = page.getByRole('textbox', { name: 'Message', exact: true });
      const draft = 'Keep this unsent message when leaving collaboration.';
      await input.fill(draft);
      await page.waitForFunction(({ id, text }) => JSON.parse(localStorage.getItem('calli.drafts') ?? '{}')[id]?.text === text, { id: member.id, text: draft });

      // Neither the conversation toolbar nor the lead's reference/collaboration picker is an entry point.
      await page.locator('.topbar-more').click();
      await threadMenu(page, member).waitFor();
      assert.equal(await threadMenu(page, member).locator('[data-menu-id="disable"], [data-menu-id="enable"]').count(), 0);
      await page.keyboard.press('Escape');
      await openThread(page, root);
      await openCollaboration(page);
      const candidate = page.getByRole('menuitem', { name: 'Assign a task to Claude Code', exact: true });
      await candidate.waitFor();
      assert.equal(await page.locator('.coord-object-actions').count(), 0);
      await candidate.click({ button: 'right' });
      await page.locator('.coord-picker-panel').waitFor();
      assert.equal(await page.locator('.menu-panel[aria-label^="Collaboration actions for "]').count(), 0);
      await page.keyboard.press('Escape');
      await openReferences(page);
      assert.equal(await page.locator('.reference-picker .coord-object-actions').count(), 0);
      assert.equal(await page.getByRole('menuitem', { name: /^(Disable|Enable) this (instance|member)$/ }).count(), 0);
      await page.keyboard.press('Escape');

      await openThread(page, member);
      assert.equal(await input.inputValue(), draft);
      const row = teamMemberRow(page, root, member);
      if (phone) {
        await showList(page, true);
        await expandTeam(page, root);
        await row.scrollIntoViewIfNeeded();
        const cdp = await context.newCDPSession(page);
        let bounds = await row.boundingBox();
        assert.ok(bounds);
        let point = { x: bounds.x + 60, y: bounds.y + bounds.height / 2 };
        // A scrolling gesture held past 450 ms must not open a menu or change the thread.
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
        await page.waitForTimeout(100);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y - 35 }] });
        await page.waitForTimeout(650);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        assert.equal(await threadMenu(page, member).count(), 0);
        assert.equal((await read(daemon, `/api/threads/${member.id}`)).disabled, false);
        await row.scrollIntoViewIfNeeded();
        bounds = await row.boundingBox();
        assert.ok(bounds);
        point = { x: bounds.x + 60, y: bounds.y + bounds.height / 2 };
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
        await threadMenu(page, member).waitFor();
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        // The compatibility click under the lifted finger must not accidentally choose Disable.
        await threadMenu(page, member).getByRole('menuitem', { name: 'Disable', exact: true }).evaluate(element => {
          for (const type of ['mousedown', 'mouseup', 'click']) element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
        });
        await page.waitForTimeout(100);
        assert.equal((await read(daemon, `/api/threads/${member.id}`)).disabled, false);
        assert.equal(mutations.filter(request => request.method === 'PATCH' && Object.hasOwn(request.body ?? {}, 'disabled')).length, 0);
        await page.waitForFunction(title => {
          const menu = [...document.querySelectorAll('.menu-panel[role="menu"]')].find(menu => menu.getAttribute('aria-label') === title);
          return menu && !menu.closest('.sheet-unarmed');
        }, member.title);
      } else await openListMenu(page, member, row, false, false, root);
      await assertListMenu(page, member, false);
      await chooseSwitch(page, daemon, member, true);
      for (const control of [root, sibling, other]) assert.equal((await read(daemon, `/api/threads/${control.id}`)).disabled, false);
      assert.equal((await read(daemon, `/api/threads/${member.id}`)).coordination?.rootId, root.id);
      assert.equal(await page.locator('.collaboration-disabled-marker').count(), 0, 'the retired aggregate markers are gone');

      await page.reload();
      await page.locator('.sidebar-inner').waitFor({ state: 'attached' });
      await openThread(page, member);
      assert.equal(await input.inputValue(), draft);
      assert.equal(await input.isEnabled(), true);
      assert.equal(await page.locator('.composer .send-btn:not(.stop)').isEnabled(), true);
      await page.getByRole('button', { name: 'Start realtime voice', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Start realtime voice', exact: true }).isEnabled(), true);
      assert.equal(await page.locator(`.row.user[data-turn="${historical.turnId}"] .bubble`).innerText(), historyText);
      await openListMenu(page, member, row, phone, true, root);
      await assertListMenu(page, member, true);
      await page.keyboard.press('Escape');
      await openThread(page, member);
      const manual = await sendManually(page, daemon, member, draft);
      assert.equal(await page.locator(`.row.user[data-turn="${manual.turnId}"] .bubble`).innerText(), draft);
      assert.equal((await read(daemon, `/api/threads/${member.id}`)).disabled, true);
      assert.equal((await read(daemon, `/api/threads/${member.id}`)).coordination?.rootId, root.id);
      const laterDraft = 'Another unsent message survives a refused save and restoration.';
      await input.fill(laterDraft);

      // A rejected enable keeps the durable value and the same recovery action, never fake success.
      let refuse = true;
      const pattern = `**/api/threads/${member.id}`;
      const handler = route => {
        if (refuse && route.request().method() === 'PATCH' && Object.hasOwn(route.request().postDataJSON(), 'disabled')) {
          refuse = false;
          return route.fulfill({ status: 503, json: { error: 'thread switch save refused' } });
        }
        return route.continue();
      };
      await page.route(pattern, handler);
      await openListMenu(page, member, row, phone, true, root);
      const failing = page.waitForResponse(response => new URL(response.url()).pathname === `/api/threads/${member.id}` && response.request().method() === 'PATCH' && response.request().postDataJSON()?.disabled === false);
      await threadMenu(page, member).getByRole('menuitem', { name: 'Enable', exact: true }).click();
      const refused = await failing;
      assert.deepEqual(refused.request().postDataJSON(), { disabled: false });
      assert.equal(refused.status(), 503);
      // Errors belong to the chat open when saving: phone list access left the lead on screen.
      if (phone) {
        await threadRow(page, root).locator('.thread-item').click();
        await page.waitForFunction(() => !document.documentElement.classList.contains('list-open'));
      }
      await page.getByText('thread switch save refused', { exact: true }).waitFor();
      await openThread(page, member);
      assert.equal((await read(daemon, `/api/threads/${member.id}`)).disabled, true);
      assert.equal(await input.inputValue(), laterDraft);
      await page.unroute(pattern, handler);
      await openListMenu(page, member, row, phone, true, root);
      await assertListMenu(page, member, true);
      await chooseSwitch(page, daemon, member, false, null, true);
      await page.reload();
      await page.locator('.sidebar-inner').waitFor({ state: 'attached' });
      await openThread(page, member);
      assert.equal(await input.inputValue(), laterDraft);
      assert.equal((await read(daemon, `/api/threads/${member.id}`)).disabled, false);
      for (const control of [root, sibling, other]) assert.equal((await read(daemon, `/api/threads/${control.id}`)).disabled, false);
      assert.equal((await read(daemon, `/api/threads/${other.id}`)).coordination, undefined);
      // Missing coordination metadata is an ordinary main Agent, not a member with a switch.
      for (const keyboard of [false, true]) {
        await openListMenu(page, other, threadRow(page, other), phone, keyboard);
        await assertListMenu(page, other);
        await page.keyboard.press('Escape');
      }
      assert.equal(mutations.some(request => request.method === 'DELETE' || /\/(cancel|stop|coordination)$/.test(request.path) || request.body?.archived === true), false, 'a switch neither stops, archives, deletes, nor enables collaboration');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test('a real member exits alone while the lead, its sibling and manual history stay available', { timeout: 90000 }, async () => {
  const { root, member, sibling } = await realMembers(daemon, 'Independent collaboration seats', 'claude');
  assert.equal(member.disabled, false);
  const history = await read(daemon, `/api/threads/${member.id}/events`);
  const beforeOthers = await Promise.all([root.id, sibling.id].map(async id => (await read(daemon, `/api/threads/${id}/events`)).filter(event => event.type === 'turn.started')));
  const context = await contextFor(false, 'light');
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await openUi(page, daemon);
    await openThread(page, root);
    await openCollaboration(page);
    await page.getByRole('menuitem', { name: 'Assign a task to Target_seat', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    const memberRow = teamMemberRow(page, root, member);
    await openListMenu(page, member, memberRow, false, false, root);
    await assertListMenu(page, member, false);
    await chooseSwitch(page, daemon, member, true);
    assert.equal((await read(daemon, `/api/threads/${root.id}`)).disabled, false);
    assert.equal((await read(daemon, `/api/threads/${sibling.id}`)).disabled, false);
    assert.deepEqual((await read(daemon, `/api/threads/${member.id}/events`)).slice(0, history.length), history, 'the saved switch may append metadata, but never removes existing member history');
    const team = await read(daemon, `/api/threads/${root.id}/coordination`);
    assert.equal(team.members.find(value => value.id === member.id)?.thread?.disabled, true, 'the current team projection carries the actual member thread switch');
    assert.equal(team.members.find(value => value.id === sibling.id)?.thread?.disabled, false);
    await memberRow.waitFor();
    // No navigation or refresh: the current root picker must not revive stale member eligibility.
    assert.equal(await page.locator('.topbar-title').innerText(), root.title);
    await openCollaboration(page);
    assert.equal(await page.getByRole('menuitem', { name: 'Assign a task to Target_seat', exact: true }).count(), 0);
    await page.getByRole('menuitem', { name: 'Assign a task to Sibling_seat', exact: true }).waitFor();
    await page.getByRole('menuitem', { name: 'Assign a task to Claude Code', exact: true }).waitFor();
    assert.equal(await page.locator('.coord-object-actions').count(), 0);
    await page.keyboard.press('Escape');

    await page.reload();
    await page.locator('.sidebar-inner').waitFor({ state: 'attached' });
    await openThread(page, member);
    const input = page.getByRole('textbox', { name: 'Message', exact: true });
    const draft = 'A member conversation remains an ordinary manual chat.';
    await input.fill(draft);
    assert.equal(await input.isEnabled(), true);
    await sendManually(page, daemon, member, draft);
    const afterHistory = await read(daemon, `/api/threads/${member.id}/events`);
    assert.deepEqual(afterHistory.slice(0, history.length), history, 'exiting collaboration never deletes member results');
    assert.deepEqual(await Promise.all([root.id, sibling.id].map(async id => (await read(daemon, `/api/threads/${id}/events`)).filter(event => event.type === 'turn.started'))), beforeOthers, 'manual chat with the exited seat is not an automatic lead or sibling turn');
    await openThread(page, root);
    await openListMenu(page, member, memberRow, false, true, root);
    await assertListMenu(page, member, true);
    await chooseSwitch(page, daemon, member, false);
    await openCollaboration(page);
    await page.getByRole('menuitem', { name: 'Assign a task to Target_seat', exact: true }).waitFor();
    await page.keyboard.press('Escape');

    // The actual collaboration lead retains its menu, but never offers a self-disable or enable action.
    for (const keyboard of [false, true]) {
      await openListMenu(page, root, threadRow(page, root), false, keyboard);
      const menu = page.getByRole('menu', { name: root.title, exact: true });
      assert.equal(await menu.locator('[data-menu-id="disable"], [data-menu-id="enable"]').count(), 0);
      await menu.locator('[data-menu-id="archive"]').waitFor();
      await page.keyboard.press('Escape');
    }
    assert.equal((await read(daemon, `/api/threads/${root.id}`)).disabled, false);
    assert.equal((await read(daemon, `/api/threads/${member.id}`)).disabled, false);
    assert.equal((await read(daemon, `/api/threads/${sibling.id}`)).disabled, false);
    assert.equal(await page.locator('.collaboration-disabled-marker').count(), 0);
  } finally { await context.close(); }
});

test('the remote sidebar switch patches the exact machine and retains its manual draft', { timeout: 90000 }, async t => {
  // A real relay to another throwaway hub exercises machine ownership, not a proxy mock.
  const node = await startDaemon({ CALLI_AGENTS_JSON: JSON.stringify({ agents: [{ id: 'pi', adapter: 'pi', command: ['fake-pi'] }] }) });
  t.diagnostic(`Remote fake hub PID ${node.pid}, port ${new URL(node.base).port}, data ${node.dataDir}, work ${node.workdir}`);
  let context;
  try {
    const machine = await linkDaemon(daemon, node, 'Switch node');
    const { root, member: remote, sibling } = await realMembers(node, 'Remote single-thread switch');
    assert.equal(remote.disabled, false);
    assert.equal(remote.coordination?.rootId, root.id);
    const ordinary = await post(node, '/api/threads', { agent: 'pi', cwd: node.workdir, title: 'Remote ordinary main control' });
    assert.equal(ordinary.disabled, false);
    assert.equal(ordinary.coordination, undefined);
    const local = await post(daemon, '/api/threads', { agent: 'pi', cwd: daemon.workdir, title: 'Local same-instance control' });
    assert.equal(local.disabled, false);
    const localIds = (await read(daemon, '/api/threads')).map(thread => thread.id).sort();
    const localBefore = await read(daemon, `/api/threads/${local.id}`);
    const localHistory = await read(daemon, `/api/threads/${local.id}/events`);
    context = await contextFor(false, 'dark');
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const switches = [];
    page.on('request', request => {
      if (request.method() === 'PATCH' && Object.hasOwn(request.postDataJSON() ?? {}, 'disabled')) switches.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
    });
    await openUi(page, daemon);
    await openThread(page, remote, machine.id);
    const row = teamMemberRow(page, root, remote);
    const input = page.getByRole('textbox', { name: 'Message', exact: true });
    const draft = 'Remote unsent text stays on its own machine and conversation.';
    await input.fill(draft);
    await page.waitForFunction(({ key, text }) => JSON.parse(localStorage.getItem('calli.drafts') ?? '{}')[key]?.text === text, { key: `host:${machine.id}:${remote.id}`, text: draft });
    await openListMenu(page, remote, row, false, false, root);
    await assertListMenu(page, remote, false);
    await chooseSwitch(page, node, remote, true, machine.id);
    assert.equal((await read(daemon, `/api/threads/${local.id}`)).disabled, false);
    await page.reload();
    await page.locator('.sidebar-inner').waitFor({ state: 'attached' });
    await openThread(page, remote, machine.id);
    assert.equal(await input.inputValue(), draft);
    await openListMenu(page, remote, row, false, true, root);
    await assertListMenu(page, remote, true);
    await page.keyboard.press('Escape');
    const sent = await sendManually(page, node, remote, draft, machine.id);
    assert.equal(await page.locator(`.row.user[data-turn="${sent.turnId}"] .bubble`).innerText(), draft);
    assert.equal((await read(node, `/api/threads/${remote.id}`)).disabled, true);
    await input.fill('Keep this next remote draft through enable.');
    await openListMenu(page, remote, row, false, true, root);
    await chooseSwitch(page, node, remote, false, machine.id, true);
    assert.equal(await input.inputValue(), 'Keep this next remote draft through enable.');
    // The same host API supplies native main records; neither its lead nor an ordinary main has a switch.
    for (const main of [root, ordinary]) {
      await openThread(page, main, machine.id);
      for (const keyboard of [false, true]) {
        await openListMenu(page, main, threadRow(page, main), false, keyboard);
        await assertListMenu(page, main, null);
        await page.keyboard.press('Escape');
      }
    }
    assert.equal((await read(daemon, `/api/threads/${local.id}`)).disabled, false);
    assert.deepEqual(await read(daemon, `/api/threads/${local.id}`), localBefore, 'remote actions do not mutate the local same-instance control');
    assert.deepEqual(await read(daemon, `/api/threads/${local.id}/events`), localHistory);
    assert.deepEqual((await read(daemon, '/api/threads')).map(thread => thread.id).sort(), localIds);
    for (const control of [root, sibling, ordinary]) assert.equal((await read(node, `/api/threads/${control.id}`)).disabled, false);
    assert.equal((await read(node, `/api/threads/${ordinary.id}`)).coordination, undefined);
    assert.deepEqual(switches, [
      { path: threadPath(remote, machine.id), body: { disabled: true } },
      { path: threadPath(remote, machine.id), body: { disabled: false } },
    ], 'both saves use only the exact remote host API and member ID');
  } finally { await context?.close(); await node.stop(); }
});

test('main handovers never offer a switch and menus bind the latest and predecessor IDs', { timeout: 90000 }, async () => {
  // Seed legacy backend state on a real lead; the UI must not offer Enable even after it retires.
  const source = await post(daemon, '/api/threads', { agent: 'pi', cwd: daemon.workdir, title: 'Independent handover segments' });
  await post(daemon, `/api/threads/${source.id}/coordination`, {});
  const historyText = 'Keep the original conversation and its completed result.';
  const sent = await post(daemon, `/api/threads/${source.id}/turns`, { text: historyText });
  await until(() => read(daemon, `/api/threads/${source.id}`), value => value.status === 'idle' && Boolean(value.agentSessionId), 'the source turn did not finish');
  assert.equal((await read(daemon, threadPath(source))).coordination?.rootId, source.id);
  const context = await contextFor(false, 'dark');
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const switches = [];
    page.on('request', request => {
      if (request.method() === 'PATCH' && Object.hasOwn(request.postDataJSON() ?? {}, 'disabled')) switches.push(request.url());
    });
    await openUi(page, daemon);
    await openThread(page, source);
    const sourceDraft = 'The original draft stays with the predecessor.';
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill(sourceDraft);
    await page.waitForFunction(({ id, text }) => JSON.parse(localStorage.getItem('calli.drafts') ?? '{}')[id]?.text === text, { id: source.id, text: sourceDraft });
    for (const keyboard of [false, true]) {
      await openListMenu(page, source, threadRow(page, source), false, keyboard);
      await assertListMenu(page, source);
      await page.keyboard.press('Escape');
    }
    const next = await post(daemon, `/api/threads/${source.id}/handover-thread`, { agent: 'claude' });
    const latest = await post(daemon, `/api/threads/${next.id}/handover-thread`, { agent: 'pi' });
    // Keep handover semantics unchanged: move the live lead first, then seed its retired legacy flag.
    const seeded = await api(daemon, threadPath(source), { method: 'PATCH', body: JSON.stringify({ disabled: true }) });
    assert.equal(seeded.status, 200, await seeded.clone().text());
    const legacy = await seeded.json();
    assert.equal(legacy.id, source.id);
    assert.equal(legacy.disabled, true);
    assert.equal(legacy.coordination?.rootId, latest.id);
    assert.equal(legacy.coordination?.retired, true);
    const fork = await post(daemon, `/api/threads/${source.id}/fork`, {});
    assert.equal(fork.disabled, false, 'a manual fork does not copy collaboration exclusion');
    assert.equal(fork.coordination, undefined);
    assert.equal(next.disabled, false);
    assert.equal(latest.disabled, false);
    const current = await read(daemon, `/api/threads/${latest.id}`);
    assert.equal(current.coordination?.rootId, latest.id);
    assert.notEqual(current.coordination?.retired, true);
    for (const old of [source, next]) {
      const retired = await read(daemon, `/api/threads/${old.id}`);
      assert.equal(retired.coordination?.rootId, latest.id);
      assert.equal(retired.coordination?.retired, true, 'the predecessor is a retired former lead, not a current member');
    }
    await openThread(page, latest);
    const group = page.locator('.sidebar .handover-group:not(.team-group)').filter({ has: page.getByText(source.title, { exact: true }) });
    const latestRow = group.locator(':scope > .thread-row');
    await latestRow.waitFor();
    assert.equal(await group.locator('.handover-chain').count(), 0);
    await openListMenu(page, latest, latestRow, false);
    await assertListMenu(page, latest);
    await choosePin(page, latest, true);
    assert.equal((await read(daemon, `/api/threads/${source.id}`)).disabled, true);
    assert.equal((await read(daemon, `/api/threads/${next.id}`)).disabled, false);
    assert.equal((await read(daemon, `/api/threads/${fork.id}`)).disabled, false);
    for (const control of [source, next, fork]) assert.equal((await read(daemon, `/api/threads/${control.id}`)).pinned, false);
    // Pin files the latest thread in a different sidebar section; do not reuse the old chain row.
    const pinnedLatestRow = page.locator('.sidebar .thread-group').filter({ has: page.getByText('Pinned', { exact: true }) }).locator('.thread-row.active');
    await openListMenu(page, latest, pinnedLatestRow, false, true);
    await assertListMenu(page, latest);
    await choosePin(page, latest, false, true);
    assert.equal((await read(daemon, `/api/threads/${source.id}`)).disabled, true, 'latest-row actions do not restore a legacy predecessor');

    await page.reload();
    await page.locator('.sidebar-inner').waitFor({ state: 'attached' });
    await openThread(page, latest);
    const toggle = group.locator(':scope > .handover-toggle');
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    const predecessor = group.locator('.handover-chain .handover-member').filter({ has: page.getByText('Original', { exact: true }) });
    await openListMenu(page, source, predecessor, false);
    await assertListMenu(page, source);
    await page.keyboard.press('Escape');
    const middle = group.locator(`.handover-chain .handover-member[title^=${JSON.stringify(`${next.title} · `)}]`);
    await openListMenu(page, next, middle, false, true);
    await assertListMenu(page, next);
    await page.keyboard.press('Escape');
    await openListMenu(page, source, predecessor, false, true);
    await assertListMenu(page, source);
    await choosePin(page, source, true, true);
    for (const control of [latest, next, fork]) {
      const unchanged = await read(daemon, `/api/threads/${control.id}`);
      assert.equal(unchanged.disabled, false);
      assert.equal(unchanged.pinned, false);
    }
    await openThread(page, source);
    assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), sourceDraft);
    assert.equal(await page.locator(`.row.user[data-turn="${sent.turnId}"] .bubble`).innerText(), historyText);
    assert.equal((await read(daemon, `/api/threads/${source.id}`)).disabled, true, 'main Agent menus never PATCH the legacy switch');
    assert.deepEqual(switches, []);
    assert.equal((await read(daemon, `/api/threads/${source.id}/events`)).filter(event => event.type === 'turn.started').length, 1, 'menu actions never dispatch another source turn');
  } finally { await context.close(); }
});

test('a running member finishes naturally and both user queues still drain while disabled', { timeout: 90000 }, async () => {
  // The existing wait-first fixture settles itself; the switch must not cancel it or its user queue.
  const { root, member, sibling } = await realMembers(daemon, 'Running single-thread switch');
  const baselineStarts = (await read(daemon, `/api/threads/${member.id}/events`)).filter(event => event.type === 'turn.started');
  const running = await post(daemon, `/api/threads/${member.id}/turns`, { text: 'wait-first: finish naturally after the menu switch.' });
  await until(() => read(daemon, `/api/threads/${member.id}`), value => value.status === 'running', 'the finite fake turn did not start');
  const context = await contextFor(false, 'light');
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const stops = [];
    page.on('request', request => {
      if (request.method() === 'POST' && /\/(cancel|stop)$/.test(new URL(request.url()).pathname)) stops.push(request.url());
    });
    await openUi(page, daemon);
    await openThread(page, member);
    const row = teamMemberRow(page, root, member);
    const beforeText = 'This manual queued message predates the switch.';
    await sendManually(page, daemon, member, beforeText, null, true);
    const queuedBefore = (await read(daemon, `/api/threads/${member.id}`)).queued;
    assert.equal(queuedBefore.length, 1);
    const input = page.getByRole('textbox', { name: 'Message', exact: true });
    await input.fill('An unsent draft must not be cleared by a running-thread switch.');
    await openListMenu(page, member, row, false, true, root);
    await chooseSwitch(page, daemon, member, true, null, true);
    const changed = await read(daemon, `/api/threads/${member.id}`);
    assert.equal(changed.status, 'running');
    assert.deepEqual(changed.queued, queuedBefore, 'existing user queue entries are not withdrawn as collaboration messages');
    assert.equal(await input.inputValue(), 'An unsent draft must not be cleared by a running-thread switch.');
    assert.equal(await input.isEnabled(), true);
    const afterText = 'This manual queued message is accepted after the switch.';
    await sendManually(page, daemon, member, afterText, null, true);
    const queuedAfter = (await read(daemon, `/api/threads/${member.id}`)).queued;
    assert.deepEqual(queuedAfter.map(message => message.text), [beforeText, afterText]);
    const draft = 'Keep this draft while ordinary queued messages finish.';
    await input.fill(draft);
    await until(() => read(daemon, `/api/threads/${member.id}`), value => value.status === 'idle' && !value.queued.length, 'disabled-thread user queues did not drain', 30000);
    await page.getByText('Response received.', { exact: true }).waitFor();
    const events = await read(daemon, `/api/threads/${member.id}/events`);
    const starts = events.filter(event => event.type === 'turn.started');
    assert.deepEqual(starts.slice(0, baselineStarts.length), baselineStarts, 'fixture member creation history stays intact');
    const newStarts = starts.slice(baselineStarts.length);
    assert.equal(newStarts.length, 3, 'exactly the running turn and two manual queued turns start after the fixture');
    assert.ok(newStarts.some(event => event.turnId === running.turnId));
    assert.ok(newStarts.some(event => event.data.text === beforeText));
    assert.ok(newStarts.some(event => event.data.text === afterText));
    assert.deepEqual(stops, []);
    assert.equal((await read(daemon, `/api/threads/${member.id}`)).disabled, true);
    for (const control of [root, sibling]) assert.equal((await read(daemon, `/api/threads/${control.id}`)).disabled, false);
    await page.reload();
    await page.locator('.sidebar-inner').waitFor({ state: 'attached' });
    await openThread(page, member);
    assert.equal(await input.inputValue(), draft);
    await page.getByText(beforeText, { exact: true }).waitFor();
    await page.getByText(afterText, { exact: true }).waitFor();
    await openListMenu(page, member, row, false, true, root);
    await assertListMenu(page, member, true);
    await chooseSwitch(page, daemon, member, false, null, true);
    assert.equal((await read(daemon, `/api/threads/${member.id}`)).queued.length, 0, 'enable does not replay already consumed user queue entries');
    assert.equal((await read(daemon, `/api/threads/${member.id}/events`)).filter(event => event.type === 'turn.started').length - baselineStarts.length, 3);
  } finally { await context.close(); }
});
