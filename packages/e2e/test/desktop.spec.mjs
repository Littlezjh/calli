// The remote desktop: a real Xvnc started for the test, seen through the daemon's WebSocket and
// noVNC. View only until Control is pressed; the VNC password is asked once and kept on the device.
// Skipped where Xvnc is not installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon, openUi, api, launchBrowser } from '../harness.mjs';

const which = (cmd) => {
  try {
    return execFileSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
};
const xvnc = which('Xvnc');
const xterm = which('xterm');
const vncpasswd = which('vncpasswd');
const skip = !xvnc || !xterm || !vncpasswd ? 'needs Xvnc, xterm and vncpasswd' : false;

let dir;
const children = [];
let open; // a desktop without a password, with an xterm that writes the line it reads
let locked; // a desktop with a VNC password
let daemonOpen;
let daemonLocked;
let daemonNone;
let browser;

/** A display number nobody uses, so the test never touches a real desktop. */
function freeDisplay(from) {
  for (let n = from; n < from + 100; n++) if (!existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`)) return n;
  throw new Error('no free display');
}

async function startXvnc(display, security) {
  const port = 5900 + display;
  const child = spawn(xvnc, [`:${display}`, '-rfbport', String(port), '-localhost', '-geometry', '1024x640', '-depth', '24', ...security], { stdio: 'ignore' });
  children.push(child);
  for (let i = 0; i < 100 && !existsSync(`/tmp/.X11-unix/X${display}`); i++) await new Promise((r) => setTimeout(r, 50));
  return { display, port, pid: child.pid };
}

before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), 'rah-e2e-desktop-'));
  open = await startXvnc(freeDisplay(70), ['-SecurityTypes', 'None']);
  const passwd = join(dir, 'passwd');
  writeFileSync(passwd, execFileSync(vncpasswd, ['-f'], { input: 'secret12\n' }));
  locked = await startXvnc(freeDisplay(open.display + 1), ['-SecurityTypes', 'VncAuth', '-PasswordFile', passwd]);
  // Without a window manager, keys go to the window under the pointer: the xterm fills the screen.
  const out = join(dir, 'typed.txt');
  children.push(spawn(xterm, ['-geometry', '200x60+0+0', '-e', 'sh', '-c', `read line; printf '%s' "$line" > ${out}; sleep 600`], { env: { ...process.env, DISPLAY: `:${open.display}` }, stdio: 'ignore' }));
  open.out = out;
  daemonOpen = await startDaemon({ RAH_DESKTOP_VNC: `127.0.0.1:${open.port}` });
  daemonLocked = await startDaemon({ RAH_DESKTOP_VNC: `127.0.0.1:${locked.port}` });
  daemonNone = await startDaemon({ RAH_DESKTOP_VNC: 'off' });
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  await daemonOpen?.stop();
  await daemonLocked?.stop();
  await daemonNone?.stop();
  for (const child of children) child.kill('SIGTERM');
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function openThread(page, daemon, title) {
  await openUi(page, daemon);
  await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: daemon.workdir, title }) });
  if (await page.locator('.menu-btn').isVisible()) await page.locator('.menu-btn').click();
  await page.locator('.thread-item', { hasText: title }).click();
}

const connected = (page) => page.locator('.desktop-screen canvas').waitFor({ timeout: 15_000 }).then(() => page.locator('.desktop-panel .term-note').waitFor({ state: 'detached', timeout: 15_000 }));

test('a machine without a desktop offers none', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await openThread(page, daemonNone, '没有桌面');
    await page.locator('.topbar-term').waitFor();
    assert.equal(await page.locator('.topbar-desktop').count(), 0);
  } finally {
    await page.close();
  }
});

test('the desktop opens view only; keys reach it only after Control', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await openThread(page, daemonOpen, '桌面');
    await page.getByLabel('打开桌面').click();
    await connected(page);
    const control = page.locator('.desktop-control');
    assert.equal(await control.getAttribute('aria-pressed'), 'false');
    const box = await page.locator('.desktop-screen canvas').boundingBox();
    assert.ok(box && box.width > 300 && box.height > 150, 'the picture is scaled into the panel');

    // View only: clicking and typing on the picture send nothing.
    await page.locator('.desktop-screen').click();
    await page.keyboard.type('nope');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    assert.equal(existsSync(open.out), false);

    await control.click();
    assert.equal(await control.getAttribute('aria-pressed'), 'true');
    await page.getByLabel('键盘').click();
    await page.getByLabel('发给桌面的文字').fill('hello-desktop');
    await page.getByLabel('发给桌面的文字').press('Enter');
    await waitForFile(open.out);
    assert.equal(readFileSync(open.out, 'utf8'), 'hello-desktop');
    for (const dark of [false, true]) {
      await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
      await page.screenshot({ path: shot(`desktop-${dark ? 'dark' : 'light'}`) });
    }
  } finally {
    await page.close();
  }
});

test('the VNC password is asked, asked again when wrong, then kept on the device', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  try {
    await openThread(page, daemonLocked, '有密码的桌面');
    await page.getByLabel('打开桌面').click();
    const field = page.locator('.dialog input');
    await field.waitFor();
    assert.equal(await page.locator('.dialog').count(), 1);
    assert.equal(await field.getAttribute('type'), 'password');
    await field.fill('wrong123');
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await page.getByText('密码不对，请重新输入').waitFor({ timeout: 15_000 });
    await page.locator('.dialog input').fill('secret12');
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await connected(page);

    await page.getByLabel('关闭').last().click();
    await page.reload();
    await page.locator('.thread-item', { hasText: '有密码的桌面' }).click();
    await page.getByLabel('打开桌面').click();
    await connected(page);
    assert.equal(await page.locator('.dialog').count(), 0, 'not asked again');
  } finally {
    await ctx.close();
  }
});

test('on a phone the desktop opens from the thread menu, with a typing bar under Control', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  try {
    await openThread(page, daemonOpen, '手机桌面');
    await page.locator('.topbar-more').click();
    await page.getByRole('menuitem', { name: '打开桌面' }).click();
    await connected(page);
    assert.equal(await page.locator('.desktop-input').count(), 0, 'no typing while view only');
    await page.locator('.desktop-control').click();
    await page.locator('.desktop-input').waitFor();
    for (const dark of [false, true]) {
      await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
      await page.screenshot({ path: shot(`desktop-phone-${dark ? 'dark' : 'light'}`) });
    }
  } finally {
    await ctx.close();
  }
});

function shot(name) {
  return join(process.env.RAH_SHOTS ?? join(tmpdir(), 'rah-shots'), `${name}.png`);
}

async function waitForFile(path, timeout = 10_000) {
  const start = Date.now();
  while (!existsSync(path) || !readFileSync(path, 'utf8')) {
    if (Date.now() - start > timeout) throw new Error(`${path} was not written`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
