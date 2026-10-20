import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, openUi, api, launchBrowser, repoRoot } from '../harness.mjs';

let daemon, browser;
before(async () => {
  daemon = await startDaemon({ RAH_AGENTS_JSON: JSON.stringify({ agents: [{
    id: 'voice-provider', adapter: 'codex',
    command: [process.execPath, join(repoRoot, 'daemon/test/fixtures/fake-codex.mjs')],
  }, { id: 'text-provider', adapter: 'claude', command: [process.execPath, join(repoRoot, 'daemon/test/fixtures/fake-acp.mjs')] }] }), FAKE_CODEX_VOICE_TASK: 'approve' });
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); await daemon?.stop(); });

// This tests the built product and real daemon/adapter with synthetic browser media/signaling.
// The separate voice-media test negotiates actual Chromium peers; neither uses a real microphone.
async function mediaFixture(context) {
  await context.addInitScript(() => {
    window.voiceTracks = [];
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
      if (window.voiceDeny) throw new DOMException('denied by test', 'NotAllowedError');
      const audio = new AudioContext();
      const stream = audio.createMediaStreamDestination().stream;
      window.voiceTracks.push(...stream.getTracks());
      return stream;
    } });
    class Peer extends EventTarget {
      connectionState = 'new';
      iceConnectionState = 'new';
      iceGatheringState = 'complete';
      localDescription = null;
      addTrack() {}
      createDataChannel() { return { readyState: 'open', close() {}, send() {} }; }
      async createOffer() { return { type: 'offer', sdp: 'fixture-offer' }; }
      async setLocalDescription(value) { this.localDescription = value; }
      async setRemoteDescription(value) {
        if (value.sdp !== 'fixture-answer') throw new Error('Unexpected test answer');
        this.connectionState = 'connected';
        this.dispatchEvent(new Event('connectionstatechange'));
      }
      close() { this.connectionState = 'closed'; }
    }
    window.RTCPeerConnection = Peer;
  });
}

async function threadPage(context, title, agent = 'voice-provider') {
  const response = await api(daemon, '/api/threads', { method: 'POST', body: JSON.stringify({
    agent, cwd: daemon.workdir, title,
  }) });
  assert.equal(response.status, 201);
  const thread = await response.json();
  const page = await context.newPage();
  await openUi(page, daemon);
  if (page.viewportSize().width < 600) await page.locator('.menu-btn').click();
  await page.locator('.thread-title', { hasText: title }).first().click();
  if (page.viewportSize().width < 600) await page.waitForFunction(() => document.querySelector('.main').getBoundingClientRect().left < 1);
  return { page, thread };
}

test('voice is opt-in; stopping voice preserves native approval and work on desktop/phone in both themes', { timeout: 120_000 }, async () => {
  const plain = await browser.newContext();
  try {
    const { page } = await threadPage(plain, '尚未安装语音');
    assert.equal(await page.getByRole('button', { name: '开启实时语音', exact: true }).count(), 0);
  } finally { await plain.close(); }
  const installed = await api(daemon, '/api/extensions/voice/install', {
    method: 'POST', body: JSON.stringify({ granted: ['voice.control'] }),
  });
  assert.equal(installed.status, 200, await installed.text());
  const textOnly = await browser.newContext();
  try {
    const { page } = await threadPage(textOnly, '仅文字提供方', 'text-provider');
    assert.equal(await page.getByRole('button', { name: '开启实时语音', exact: true }).count(), 0);
  } finally { await textOnly.close(); }
  for (const mobile of [false, true]) for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 900 },
      isMobile: mobile, hasTouch: mobile, colorScheme });
    try {
      await mediaFixture(context);
      const { page, thread } = await threadPage(context, `语音 ${mobile ? '手机' : '桌面'} ${colorScheme}`);
      if (process.env.RAH_E2E_SHOTS_DIR) {
        mkdirSync(process.env.RAH_E2E_SHOTS_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.RAH_E2E_SHOTS_DIR, `voice-idle-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`) });
      }
      await page.getByRole('button', { name: '开启实时语音', exact: true }).click();
      await page.getByText('实时语音中', { exact: true }).waitFor();
      await page.getByRole('button', { name: '静音', exact: true }).click();
      assert.ok(await page.evaluate(() => window.voiceTracks.every(t => !t.enabled)));
      await page.getByRole('button', { name: '取消静音', exact: true }).click();
      const bar = page.locator('.voice-bar');
      await page.locator('.action-sheet').waitFor();
      const sheet = await page.locator('.action-sheet').boundingBox();
      const bounds = await bar.boundingBox();
      assert.ok(sheet && bounds && (sheet.y + sheet.height <= bounds.y + 1 || bounds.y + bounds.height <= sheet.y + 1),
        'voice controls and approval must not overlap');
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= page.viewportSize().width + 1);
      if (process.env.RAH_E2E_SHOTS_DIR) {
        mkdirSync(process.env.RAH_E2E_SHOTS_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.RAH_E2E_SHOTS_DIR, `voice-${mobile ? 'phone' : 'desktop'}-${colorScheme}.png`) });
      }
      await bar.getByRole('button', { name: '结束语音', exact: true }).click();
      await page.waitForFunction(() => window.voiceTracks.length > 0 && window.voiceTracks.every(t => t.readyState === 'ended'));
      const detail = await (await api(daemon, `/api/threads/${thread.id}`)).json();
      assert.equal(detail.status, 'running', 'ending media must preserve pending native work');
      // Answer the actual native approval through the UI, then observe its result.
      await page.getByRole('button', { name: '允许这一次', exact: true }).click();
      await page.getByText(/approved:accept/, { exact: false }).first().waitFor();
    } finally { await context.close(); }
  }
});


test('microphone refusal is visible and disabling an extension releases media without approving work', { timeout: 30_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await mediaFixture(context);
    const { page, thread } = await threadPage(context, '语音权限与停用');
    await page.evaluate(() => { window.voiceDeny = true; });
    await page.getByRole('button', { name: '开启实时语音', exact: true }).click();
    await page.getByText('麦克风权限被拒绝，请在浏览器地址栏允许麦克风访问。', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.voiceTracks.length), 0);
    await page.evaluate(() => { window.voiceDeny = false; });
    await page.getByRole('button', { name: '开启实时语音', exact: true }).click();
    await page.getByText('实时语音中', { exact: true }).waitFor();
    await page.locator('.action-sheet').waitFor();
    assert.equal((await api(daemon, '/api/extensions/voice', { method: 'PATCH', body: JSON.stringify({ enabled: false }) })).status, 200);
    await page.waitForFunction(() => window.voiceTracks.length === 1 && window.voiceTracks[0].readyState === 'ended');
    assert.equal((await (await api(daemon, `/api/threads/${thread.id}`)).json()).status, 'running');
    assert.equal((await api(daemon, '/api/extensions/voice', { method: 'PATCH', body: JSON.stringify({ enabled: true }) })).status, 200);
    // Re-enabling permission does not reacquire the microphone or answer an approval.
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => window.voiceTracks.length), 1);
    assert.equal((await (await api(daemon, `/api/threads/${thread.id}`)).json()).status, 'running');
  } finally { await context.close(); }
});
