// The remote desktop, opened from the sidebar: a real Xvnc started for the test, seen through the daemon's WebSocket and
// noVNC. View only until Control is pressed; the VNC password is asked once and kept on the device.
// Skipped where Xvnc is not installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { connect } from 'node:net';
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
const xclip = which('xclip');
const skip = !xvnc || !xterm || !vncpasswd ? 'needs Xvnc, xterm and vncpasswd' : false;
const skipClip = skip || (!xclip ? 'needs xclip' : false);

let dir;
const children = [];
let open; // a desktop without a password, with an xterm that writes the line it reads
let locked; // a desktop with a VNC password
let daemonOpen;
let daemonLocked;
let daemonNone;
let blocked; // a desktop with a password that has turned this address away
let daemonBlocked;
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
  blocked = await startXvnc(freeDisplay(locked.display + 1), ['-SecurityTypes', 'VncAuth', '-PasswordFile', passwd]);
  // Without a window manager, keys go to the window under the pointer: the xterm fills the screen.
  const out = join(dir, 'typed.txt');
  children.push(spawn(xterm, ['-geometry', '200x60+0+0', '-e', 'sh', '-c', `read line; printf '%s' "$line" > ${out}; sleep 600`], { env: { ...process.env, DISPLAY: `:${open.display}` }, stdio: 'ignore' }));
  open.out = out;
  daemonOpen = await startDaemon({ RAH_DESKTOP_VNC: `127.0.0.1:${open.port}` });
  daemonLocked = await startDaemon({ RAH_DESKTOP_VNC: `127.0.0.1:${locked.port}` });
  daemonNone = await startDaemon({ RAH_DESKTOP_VNC: 'off' });
  daemonBlocked = await startDaemon({ RAH_DESKTOP_VNC: `127.0.0.1:${blocked.port}` });
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  await daemonOpen?.stop();
  await daemonLocked?.stop();
  await daemonNone?.stop();
  await daemonBlocked?.stop();
  for (const child of children) child.kill('SIGTERM');
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function openThread(page, daemon, title) {
  await openUi(page, daemon);
  await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({ agent: 'pi', cwd: daemon.workdir, title }) });
  if (await page.locator('.menu-btn').isVisible()) await page.locator('.menu-btn').click();
  await page.locator('.thread-item', { hasText: title }).click();
}

/** The desktop is the machine's, not a thread's: it opens from the sidebar, behind the menu on a phone. */
async function openDesktop(page) {
  if (await page.locator('.menu-btn').isVisible()) await page.locator('.menu-btn').click();
  await page.locator('.side-desktop').click();
}

const connected = (page) => page.locator('.desktop-screen canvas').waitFor({ timeout: 15_000 }).then(() => page.locator('.desktop-panel .term-note').waitFor({ state: 'detached', timeout: 15_000 }));

test('a machine without a desktop offers none', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await openThread(page, daemonNone, '没有桌面');
    await page.locator('.side-link').first().waitFor();
    assert.equal(await page.locator('.side-desktop').count(), 0);
  } finally {
    await page.close();
  }
});

test('the desktop opens view only; keys reach it only after Control', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await openThread(page, daemonOpen, '桌面');
    await page.screenshot({ path: shot('desktop-sidebar') });
    await openDesktop(page);
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
    // A real keyboard types straight onto the desktop: no typing bar, no keyboard button.
    assert.equal(await page.locator('.desktop-input').count(), 0);
    assert.equal(await page.getByLabel('键盘').count(), 0);
    await page.locator('.desktop-screen canvas').click();
    await page.keyboard.type('hello-desktop');
    await page.keyboard.press('Enter');
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

test('minimizing keeps the connection: back from the sidebar without reconnecting', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    const sockets = [];
    page.on('websocket', (ws) => { if (ws.url().includes('/desktop/vnc')) sockets.push(ws); });
    await openUi(page, daemonOpen);
    await openDesktop(page);
    await connected(page);
    await page.locator('.desktop-control').click();

    await page.getByLabel('最小化').click();
    await page.locator('.desktop-panel').waitFor({ state: 'hidden' });
    await page.locator('.side-desktop-live').waitFor();
    await page.screenshot({ path: shot('desktop-minimized') });
    await page.waitForTimeout(500);
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].isClosed(), false, 'still connected while minimized');

    await openDesktop(page);
    await page.locator('.desktop-panel').waitFor();
    assert.equal(await page.locator('.desktop-panel .term-note').count(), 0, 'no reconnecting');
    assert.equal(await page.locator('.desktop-control').getAttribute('aria-pressed'), 'true', 'control is kept');
    const box = await page.locator('.desktop-screen canvas').boundingBox();
    assert.ok(box && box.width > 300, 'scaled again to the panel');
    assert.equal(await page.locator('.side-desktop-live').count(), 0);
    assert.equal(sockets.length, 1, 'the same connection');

    // Close disconnects; opening again is a new connection.
    await page.getByLabel('断开并关闭').click();
    await page.locator('.desktop-panel').waitFor({ state: 'detached' });
    await waitUntil(() => sockets[0].isClosed());
    await openDesktop(page);
    await connected(page);
    assert.equal(sockets.length, 2);
  } finally {
    await page.close();
  }
});

test('the clipboard goes both ways: through the sheet, and Ctrl+V / Ctrl+C on a keyboard', { skip: skipClip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const env = { ...process.env, DISPLAY: `:${open.display}` };
  const remoteClip = () => {
    try {
      return execFileSync(xclip, ['-o', '-selection', 'clipboard'], { env, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return '';
    }
  };
  // xclip stays to serve what it was given, as a desktop app that copied would.
  const copyOnDesktop = (text) => {
    const child = spawn(xclip, ['-selection', 'clipboard'], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    children.push(child);
    child.stdin.end(text);
  };
  const localClip = () => page.evaluate(() => navigator.clipboard.readText());
  try {
    await openUi(page, daemonOpen);
    await openDesktop(page);
    await connected(page);
    assert.equal(await page.locator('.desktop-clip-btn').count(), 0, 'no clipboard while view only');
    await page.locator('.desktop-control').click();

    // The desktop's copy: a dot on the button, then the sheet copies it here.
    copyOnDesktop('来自桌面 copied');
    await page.locator('.desktop-clip-btn.fresh').waitFor({ timeout: 10_000 });
    await page.locator('.desktop-clip-btn').click();
    await page.locator('.desktop-clip-text', { hasText: '来自桌面 copied' }).waitFor();
    assert.equal(await page.locator('.desktop-clip-btn.fresh').count(), 0, 'seen once the sheet is open');
    await page.getByRole('button', { name: '复制到本机' }).click();
    await page.getByText('已复制到本机').waitFor();
    assert.equal(await localClip(), '来自桌面 copied');

    // This device's text, pasted into the sheet, becomes the desktop's clipboard.
    await page.getByLabel('把本机的文字粘贴到这里').fill('发到桌面 sent');
    await page.getByRole('button', { name: '发到桌面剪贴板' }).click();
    await waitUntil(() => remoteClip() === '发到桌面 sent');
    for (const dark of [false, true]) {
      await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
      await page.screenshot({ path: shot(`desktop-clipboard-${dark ? 'dark' : 'light'}`) });
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await page.keyboard.press('Escape');
    await page.locator('.desktop-clip').waitFor({ state: 'detached' });

    // With a keyboard, Ctrl+V pastes this device's clipboard on the desktop...
    await page.evaluate(() => navigator.clipboard.writeText('粘贴 pasted'));
    await page.locator('.desktop-screen canvas').click();
    await page.keyboard.press('Control+V');
    await waitUntil(() => remoteClip() === '粘贴 pasted');
    // ...and what the desktop copies right after Ctrl+C comes here by itself.
    await page.keyboard.press('Control+C');
    copyOnDesktop('复制 copied back');
    await waitUntil(async () => (await localClip()) === '复制 copied back');
  } finally {
    await ctx.close();
  }
});

test('on plain http (no secure context) copying here still works, from the button and right after Ctrl+C', { skip: skipClip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
  // As on a VPN address: no navigator.clipboard for the page, only the copy command after a gesture.
  await ctx.addInitScript(() => Object.defineProperty(window, 'isSecureContext', { get: () => false }));
  const page = await ctx.newPage();
  const env = { ...process.env, DISPLAY: `:${open.display}` };
  const copyOnDesktop = (text) => {
    const child = spawn(xclip, ['-selection', 'clipboard'], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    children.push(child);
    child.stdin.end(text);
  };
  const localClip = () => page.evaluate(() => navigator.clipboard.readText());
  try {
    await openUi(page, daemonOpen);
    await openDesktop(page);
    await connected(page);
    await page.locator('.desktop-control').click();
    await page.locator('.desktop-screen canvas').click();
    await page.keyboard.press('Control+C');
    copyOnDesktop('http copied back');
    await waitUntil(async () => (await localClip()) === 'http copied back');
    copyOnDesktop('http from button');
    await page.locator('.desktop-clip-btn.fresh').waitFor({ timeout: 10_000 });
    await page.locator('.desktop-clip-btn').click();
    await page.getByRole('button', { name: '复制到本机' }).click();
    await page.getByText('已复制到本机').waitFor();
    assert.equal(await localClip(), 'http from button');
  } finally {
    await ctx.close();
  }
});

test('the VNC password is asked, asked again when wrong, then kept on the device', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  try {
    await openThread(page, daemonLocked, '有密码的桌面');
    await openDesktop(page);
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
    await openDesktop(page);
    await connected(page);
    assert.equal(await page.locator('.dialog').count(), 0, 'not asked again');
  } finally {
    await ctx.close();
  }
});

test('a VNC server that turns this address away says so, and the panel still closes', { skip }, async () => {
  // Five connections that leave before signing in: TigerVNC then refuses the address for a while.
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => {
      const s = connect(blocked.port, '127.0.0.1');
      s.once('data', () => s.destroy());
      s.on('close', resolve);
      s.on('error', resolve);
    });
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await openUi(page, daemonBlocked);
    await openDesktop(page);
    await page.getByText('认证失败次数过多').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(400); // past the panel's fade-in
    await page.screenshot({ path: shot('desktop-blocked') });
    assert.equal(await page.locator('.dialog').count(), 0, 'not taken for a wrong password');
    await page.locator('.desktop-panel').getByLabel('关闭').click();
    await page.locator('.desktop-panel').waitFor({ state: 'detached' });
  } finally {
    await page.close();
  }
});

test('on a phone the desktop opens from the sidebar, with a typing bar under Control', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  try {
    await openThread(page, daemonOpen, '手机桌面');
    await page.locator('.menu-btn').click();
    await page.locator('.side-desktop').waitFor();
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(500); // past the drawer sliding in
    await page.screenshot({ path: shot('desktop-phone-sidebar-dark') });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.locator('.side-desktop').click();
    await connected(page);
    assert.equal(await page.locator('.desktop-input').count(), 0, 'no typing while view only');
    await page.locator('.desktop-control').click();
    await page.locator('.desktop-input').waitFor();
    for (const dark of [false, true]) {
      await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
      await page.screenshot({ path: shot(`desktop-phone-${dark ? 'dark' : 'light'}`) });
    }
    await page.locator('.desktop-clip-btn').click();
    await page.getByLabel('把本机的文字粘贴到这里').waitFor();
    assert.equal(await page.locator('.desktop-clip-hint').count(), 0, 'no keyboard shortcuts to mention on a phone');
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot('desktop-phone-clipboard') });
  } finally {
    await ctx.close();
  }
});

function shot(name) {
  return join(process.env.RAH_SHOTS ?? join(tmpdir(), 'rah-shots'), `${name}.png`);
}

async function waitUntil(check, timeout = 10_000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function waitForFile(path, timeout = 10_000) {
  const start = Date.now();
  while (!existsSync(path) || !readFileSync(path, 'utf8')) {
    if (Date.now() - start > timeout) throw new Error(`${path} was not written`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
