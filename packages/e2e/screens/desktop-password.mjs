import { createCipheriv } from 'node:crypto';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

/** An isolated RFB password handshake for screenshots and browser tests, with no host desktop. */
export async function prepareDesktopPassword(page) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  page.once('close', () => {
    for (const client of server.clients) client.terminate();
    server.close();
  });
  await page.route('**/api/desktop', (route) => route.fulfill({ json: { available: true, port: 5900 } }));
  await page.route('**/api/desktop/ticket*', (route) => route.fulfill({ json: { url: `ws://127.0.0.1:${server.address().port}` } }));
  const challenge = Buffer.alloc(16, 0x5a);
  const key = Buffer.from('secret12', 'latin1').map((byte) => {
    let reversed = 0;
    for (let bit = 0; bit < 8; bit++) reversed = (reversed << 1) | ((byte >> bit) & 1);
    return reversed;
  });
  const cipher = createCipheriv('des-ede3', Buffer.concat([key, key, key]), null);
  cipher.setAutoPadding(false);
  const response = Buffer.concat([cipher.update(challenge), cipher.final()]);
  const state = { connections: 0 };
  server.on('connection', (socket) => {
    state.connections++;
    let phase = 'version';
    let pending = Buffer.alloc(0);
    socket.send(Buffer.from('RFB 003.008\n'));
    socket.on('error', () => undefined);
    socket.on('message', (message) => {
      pending = Buffer.concat([pending, Buffer.from(message)]);
      for (;;) {
        const length = phase === 'version' ? 12 : phase === 'auth' ? 16 : 1;
        if (phase === 'connected' || pending.length < length) return;
        const data = pending.subarray(0, length);
        pending = pending.subarray(length);
        if (phase === 'version') {
          phase = 'security';
          socket.send(Buffer.from([1, 2]));
        } else if (phase === 'security') {
          phase = 'auth';
          socket.send(challenge);
        } else if (phase === 'auth') {
          if (!data.equals(response)) {
            const reason = Buffer.from('Authentication failed');
            const refusal = Buffer.alloc(8);
            refusal.writeUInt32BE(1);
            refusal.writeUInt32BE(reason.length, 4);
            socket.send(Buffer.concat([refusal, reason]));
            socket.close();
            return;
          }
          phase = 'init';
          socket.send(Buffer.alloc(4));
        } else {
          phase = 'connected';
          const name = Buffer.from('Desktop fixture');
          const init = Buffer.alloc(24);
          init.writeUInt16BE(800);
          init.writeUInt16BE(600, 2);
          Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(init, 4);
          init.writeUInt32BE(name.length, 20);
          socket.send(Buffer.concat([init, name]));
        }
      }
    });
  });
  return state;
}

export async function openDesktopPassword(page) {
  if (await page.locator('.menu-btn').isVisible()) await page.locator('.menu-btn').click();
  const minimized = page.locator('.side-nav .side-link', { hasText: '桌面' });
  if (await minimized.count()) await minimized.click();
  else {
    await page.locator('.side-more').click();
    await page.getByRole('menuitem', { name: '桌面', exact: true }).click();
  }
  await page.locator('.desktop-password').waitFor();
}
