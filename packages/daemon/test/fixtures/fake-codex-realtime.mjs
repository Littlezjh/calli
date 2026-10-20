#!/usr/bin/env node
// Fake app-server for the CodexRealtime controller tests; speaks newline-delimited JSON-RPC on
// stdio like `codex app-server` and never touches an upstream service. Scenarios via
// FAKE_REALTIME_SCENARIO: ok (default), api-key, rpc-reject, async-error-early, async-error-late,
// exit, wrong-thread, no-started, no-sdp, no-closed, hang, stale.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const scenario = process.env.FAKE_REALTIME_SCENARIO ?? 'ok';
const threadId = 'rt-thread-1';
const otherThreadId = 'rt-other-thread';
// Secrets on purpose: tests assert the controller classifies messages instead of carrying them.
const upstreamError = () => rt('thread/realtime/error', { message: 'realtime conversation requires API key auth SECRET_TOKEN https://private.invalid/account' });

const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
const rt = (method, params = {}) => notify(method, { threadId, ...params });
const ack = id => send({ id, result: {} });

let accountReads = 0;
let stops = 0;
const lines = createInterface({ input: process.stdin });
lines.on('close', () => process.exit(0));

lines.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (process.env.FAKE_REALTIME_LOG) appendFileSync(process.env.FAKE_REALTIME_LOG, JSON.stringify(message) + '\n');
  switch (message.method) {
    case 'initialize':
      ack(message.id);
      break;
    case 'account/read': {
      accountReads++;
      if (accountReads === 2 && scenario === 'stale') {
        // Race the second start's authentication with leftovers of the first session.
        rt('thread/realtime/sdp', { sdp: 'STALE_SDP_BEFORE_START' });
        rt('thread/realtime/error', { message: 'stale SECRET failure' });
      }
      send({ id: message.id, result: { account: { type: scenario === 'api-key' ? 'apiKey' : 'chatgpt' } } });
      break;
    }
    case 'thread/realtime/start': {
      if (scenario === 'hang') break; // never acknowledged
      if (scenario === 'rpc-reject') {
        send({ id: message.id, error: { code: -32000, message: 'realtime conversation requires API key auth SECRET_TOKEN' } });
        break;
      }
      if (scenario === 'async-error-early') {
        upstreamError();
        ack(message.id);
        break;
      }
      ack(message.id);
      if (scenario === 'exit') process.exit(3);
      if (scenario === 'async-error-late') {
        setTimeout(upstreamError, 10);
        break;
      }
      if (scenario === 'wrong-thread') {
        notify('thread/realtime/started', { threadId: otherThreadId, version: 'v3' });
        notify('thread/realtime/sdp', { threadId: otherThreadId, sdp: 'WRONG_THREAD_SDP' });
      }
      if (scenario !== 'no-started') rt('thread/realtime/started', { realtimeSessionId: 'SECRET_SESSION_ID', version: 'v3' });
      if (scenario !== 'no-sdp') rt('thread/realtime/sdp', { sdp: 'v=0\r\nSECRET_SDP_ANSWER' });
      if (scenario === 'ok') {
        rt('thread/realtime/transcript/delta', { role: 'assistant', delta: '你' });
        rt('thread/realtime/item/transcript/delta', { itemId: 'item-1', delta: '好' });
        rt('thread/realtime/transcript/done', { role: 'assistant', text: '你好' });
        rt('thread/realtime/item/completed', { item: { type: 'transcriptSegment', id: 'item-1', text: '你好', role: 'assistant' } });
      }
      break;
    }
    case 'thread/realtime/stop': {
      stops++;
      ack(message.id);
      if (scenario === 'no-closed') break;
      rt('thread/realtime/closed', {});
      if (scenario === 'stale' && stops === 1) {
        // Late leftovers of a stopped session, before any new start exists.
        setTimeout(() => {
          rt('thread/realtime/error', { message: 'stale SECRET failure' });
          rt('thread/realtime/sdp', { sdp: 'STALE_SDP_AFTER_CLOSE' });
        }, 5);
      }
      break;
    }
  }
});
