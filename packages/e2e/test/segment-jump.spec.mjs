import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, openUi, api, launchBrowser } from '../harness.mjs';

// A native agent can finish background tasks after handing over. Opening its earlier segment
// must land at the handover, while its real later output reads on beneath a hairline as follow-ups.
test('overview segment jumps keep the handover boundary and the older-page button readable', async () => {
  const hub = await startDaemon();
  let browser;
  try {
    const post = async (path, body) => {
      const response = await api(hub, path, { method: 'POST', body: JSON.stringify(body) });
      assert.equal(response.status, 201); return response.json();
    };
    const source = await post('/api/threads', { agent: 'claude', cwd: hub.workdir, title: '历史问答与接力' });
    const head = await post(`/api/threads/${source.id}/handover-thread`, { agent: 'pi', mode: 'continue' });
    const db = new DatabaseSync(join(hub.dataDir, 'hub.db'));
    const insert = db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)');
    let seq = Number(db.prepare('SELECT MAX(seq) AS n FROM events WHERE thread_id=?').get(source.id).n ?? 0);
    const event = (id, turn, type, data) => insert.run(id, ++seq, turn, type, new Date(1760000000000 + seq * 1000).toISOString(), JSON.stringify(data));
    for (let i = 1; i <= 12; i++) {
      event(source.id, `a${i}`, 'turn.started', { text: `真实问题 ${i}`, ...(i === 12 ? { handover: 'pi', handoverLabel: 'Pi' } : {}) });
      event(source.id, `a${i}`, 'message.delta', { text: `第 ${i} 轮回答：历史没有丢失，已检查实现与验证范围。\n\n`.repeat(8) });
      event(source.id, `a${i}`, 'turn.done', {});
    }
    const boundary = seq;
    db.prepare("UPDATE threads SET handover=json_set(handover, '$.sourceSeq', ?, '$.method', 'summary') WHERE id=?").run(boundary, head.id);
    for (let i = 1; i <= 3; i++) {
      event(source.id, `bg${i}`, 'turn.started', { text: '', source: 'background', nativeTurnId: `background-${i}` });
      event(source.id, `bg${i}`, 'message.delta', { text: i === 1 ? '后台测试已结束，补充验证情况。\n\n'.repeat(20) : "You've hit your session limit · resets 2:20pm (UTC)" });
      event(source.id, `bg${i}`, 'turn.done', {});
    }
    event(head.id, 'b1', 'turn.started', { text: '接手摘要' });
    event(head.id, 'b1', 'message.delta', { text: '继续处理当前工作' });
    event(head.id, 'b1', 'turn.done', {});
    db.close();
    browser = await launchBrowser();
    const shots = process.env.CALLI_SHOTS ?? '/tmp/segment-jump-shots';
    mkdirSync(shots, { recursive: true });
    for (const phone of [false, true]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 960 }, isMobile: phone, hasTouch: phone, colorScheme: theme });
      try {
        const page = await context.newPage();
        const errors = [], requests = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => requests.push(request.url()));
        await openUi(page, hub);
        await page.evaluate(id => { location.hash = `#/thread/${id}`; }, head.id);
        await page.getByText('继续处理当前工作', { exact: true }).waitFor();
        if (phone) await page.getByRole('button', { name: '概况', exact: true }).click();
        await page.locator('.overview-member').filter({ hasText: source.title }).last().click();
        await page.locator('.chain-followups').waitFor();
        assert.match(await page.locator('.chain-followups .chain-line').innerText(), /3 条后续/);
        await page.locator('.handover-summary-turn').waitFor();
        assert.equal(await page.locator('.row.user', { hasText: '真实问题' }).count(), 7, 'a bounded page contains real questions and the folded summary');
        assert.ok(requests.some(url => url.includes(`/threads/${source.id}/history?`) && new URL(url).searchParams.get('before') === String(boundary + 1)), 'the read stops at the handover');
        // The follow-ups read on beneath the hairline: the real native-agent failures are on the page, with no opening step.
        await page.locator('.chain-followups .markdown', { hasText: "You've hit your session limit" }).last().waitFor();
        assert.ok(requests.some(url => url.includes(`/threads/${source.id}/history?`) && new URL(url).searchParams.get('after') === String(boundary) && new URL(url).searchParams.get('forward') === '1'), 'the follow-ups read on from the handover');
        await page.waitForTimeout(300);
        const file = `${phone ? 'phone' : 'desktop'}-${theme}`;
        await page.screenshot({ path: join(shots, `after-${file}.png`) });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        assert.equal(overflow, false);
        // Paging up must keep the earlier-message button above the floating segment label.
        await page.locator('.scroller').evaluate(el => { el.scrollTop = 0; });
        await page.waitForTimeout(100);
        const previous = page.getByRole('button', { name: '加载更早的消息', exact: true });
        await previous.waitFor();
        assert.ok(await previous.evaluate(button => {
          const box = button.getBoundingClientRect();
          return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        }), 'the floating segment header does not cover the load-older button');
        await page.screenshot({ path: join(shots, `older-${file}.png`) });
        await previous.click();
        await page.getByText('真实问题 1', { exact: true }).waitFor();
        // The follow-ups under their hairline, read where the conversation ended.
        await page.locator('.scroller').evaluate(el => { el.scrollTop = el.scrollHeight; });
        await page.locator('.chain-followups .markdown', { hasText: "You've hit your session limit" }).last().waitFor();
        await page.screenshot({ path: join(shots, `followups-${file}.png`) });
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
  } finally { await browser?.close(); await hub.stop(); }
});
