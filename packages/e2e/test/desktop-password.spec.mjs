import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startDaemon, api, launchBrowser, openUi } from '../harness.mjs';
import { prepareDesktopPassword, openDesktopPassword } from '../screens/desktop-password.mjs';

let daemon, browser, thread;
before(async () => {
  daemon = await startDaemon({ CALLI_AGENTS_JSON: JSON.stringify({ agents: [{ id: 'pi', adapter: 'pi', command: ['fake-pi'] }] }) });
  thread = await (await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: daemon.workdir, title: 'Desktop authentication' }) })).json();
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); await daemon?.stop(); });

async function open(page) {
  const state = await prepareDesktopPassword(page);
  await openUi(page, daemon);
  await page.goto(`${daemon.base}/#/thread/${thread.id}`);
  await page.locator('.composer textarea').waitFor();
  await openDesktopPassword(page);
  return state;
}
const connected = async (page) => {
  await page.locator('.desktop-panel .term-note').waitFor({ state: 'detached', timeout: 10000 });
  await page.locator('.desktop-screen canvas').waitFor();
};

test('the password stays inside the desktop while the conversation remains usable', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await open(page);
    assert.equal(await page.locator('.dialog-scrim, [aria-modal="true"]').count(), 0);
    const form = await page.locator('.desktop-password').boundingBox();
    const viewer = await page.locator('.desktop-side').boundingBox();
    assert.ok(form.x >= viewer.x && form.x + form.width <= viewer.x + viewer.width);
    assert.ok(form.y >= viewer.y && form.y + form.height <= viewer.y + viewer.height);
    const composer = page.locator('.composer textarea');
    await composer.fill('Authentication can wait while I send this message');
    await composer.press('Enter');
    await page.getByText('hi there Authentication can wait while I send this message', { exact: false }).waitFor();
    assert.equal(await page.locator('.desktop-password').isVisible(), true);
    await page.locator('.desktop-password').getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('.desktop-panel .term-note').getByText('已断开', { exact: true }).waitFor();
    assert.equal(await page.locator('.desktop-password').count(), 0);
  } finally { await page.close(); }
});

test('wrong passwords retry inside the viewer and successful credentials survive reopening', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await open(page);
    const field = page.getByLabel('VNC 密码', { exact: true });
    assert.equal(await field.getAttribute('type'), 'password');
    await field.fill('wrong123');
    await field.press('Enter');
    await page.locator('.desktop-password [role="alert"]').getByText('密码不对，请重新输入').waitFor();
    assert.equal(await page.locator('.dialog-scrim').count(), 0);
    await field.fill('secret12');
    const unhandled = await field.evaluate((input) => input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true,
    })));
    assert.equal(unhandled, false, 'the composition confirmation does not reach native form submission');
    assert.equal(await page.locator('.desktop-password').isVisible(), true, 'confirming composition does not submit the password');
    await field.press('Enter');
    await connected(page);
    assert.equal(await page.evaluate(() => localStorage.getItem('calli.vnc.local')), 'secret12');
    await page.getByRole('button', { name: '断开并关闭', exact: true }).click();
    await page.locator('.desktop-panel').waitFor({ state: 'detached' });
    await page.reload();
    if (await page.locator('.menu-btn').isVisible()) await page.locator('.menu-btn').click();
    await page.locator('.side-more').click();
    await page.getByRole('menuitem', { name: '桌面', exact: true }).click();
    await connected(page);
    assert.equal(await page.locator('.desktop-password').count(), 0);
  } finally { await page.close(); }
});

test('a phone returns to the conversation and restores the pending password on the same connection', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const state = await open(page);
    const field = page.getByLabel('VNC 密码', { exact: true });
    await field.fill('partial');
    await page.getByRole('button', { name: '返回会话', exact: true }).click();
    const composer = page.locator('.composer textarea');
    await composer.fill('Keep my draft while connecting');
    assert.equal(await page.locator('.desktop-password').isVisible(), false);
    await openDesktopPassword(page);
    assert.equal(await field.inputValue(), 'partial');
    assert.equal(state.connections, 1);
    await field.press('Escape');
    await page.locator('.desktop-panel .term-note').getByText('已断开', { exact: true }).waitFor();
  } finally { await page.close(); }
});
