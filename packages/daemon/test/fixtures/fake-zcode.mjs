#!/usr/bin/env node
// ZCode's strict NDJSON protocol: no jsonrpc field, reverse runtime preferences, native events.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const output = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (id, result) => output({ id, result });
const error = (id, message) => output({ id, error: { code: -32602, message } });
let sessionId = 'sess-zcode-fixture';
let model = { providerId: 'api', modelId: 'small' };
let mode = 'build';
let turn = null;
let seq = 0;
let nextId = 10000;
const pending = new Map();
const request = (method, params) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); output({ id, method, params }); });
const emit = (type, payload, turnId = turn?.id) => output({ method: 'session/event', params: { sessionId, eventId: `ev-${++seq}`, seq, turnId, type, payload, deliveryKind: 'desktop-continuous' } });
const snapshot = () => ({ session: { sessionId, ...(process.env.FAKE_ZCODE_GOAL ? { target: { status: 'active' } } : {}) }, settings: { mode: { current: mode }, model: { current: model, available: [{ ref: { providerId: 'api', modelId: 'small' }, label: 'Small', reasoning: { defaultLevel: 'low', levels: [{ value: 'low' }, { value: 'high' }] } }, { ref: { providerId: 'api', modelId: 'large' }, label: 'Large' }] } } });
const preferences = async () => {
  const result = await request('session/requestRuntimePreferences', { sessionId, scope: 'runtime-materialization' });
  if (process.env.FAKE_ZCODE_LOG) appendFileSync(process.env.FAKE_ZCODE_LOG, JSON.stringify({ preferences: result }) + '\n');
  return result;
};
function done(resultType = 'success', response = '完成') { if (!turn) return; emit('turn.completed', { resultType, response }); turn = null; }
async function handle(message) {
  if ('jsonrpc' in message) return error(message.id, 'Unexpected jsonrpc field');
  if (!message.method) { pending.get(message.id)?.(message.result); pending.delete(message.id); return; }
  const { id, method, params: p = {} } = message;
  if (process.env.FAKE_ZCODE_LOG) appendFileSync(process.env.FAKE_ZCODE_LOG, JSON.stringify({ method, params: p }) + '\n');
  switch (method) {
    case 'session/create': case 'session/resume': {
      sessionId = p.sessionId ?? sessionId;
      if (!process.env.FAKE_ZCODE_NO_PREFERENCES) await preferences();
      mode = p.mode ?? mode; model = p.model ?? model;
      return reply(id, snapshot());
    }
    case 'session/subscribe': return reply(id, { sessionId, eventSeq: seq, events: [] });
    case 'session/setMode': mode = p.mode; return reply(id, snapshot());
    case 'session/setModel': model = p.model; return reply(id, snapshot());
    case 'session/setThoughtLevel': return reply(id, snapshot());
    case 'session/read': return reply(id, snapshot());
    case 'session/close': reply(id, { closed: true }); return;
    case 'session/stop': reply(id, { stopped: true }); done('cancelled', ''); return;
    case 'session/send': case 'session/compact': {
      if (method === 'session/compact' && p.instructions === 'already-running') return reply(id, { compact: { state: 'already_running' } });
      turn = { id: `turn-${++seq}`, inputId: p.inputId };
      const activeTurn = turn;
      await request('session/requestRuntimePreferences', { sessionId, scope: 'user-execution' });
      if (p.content === 'reject') return error(id, 'submission rejected');
      emit('turn.started', { inputId: p.inputId });
      // Completion may precede the response to send; the adapter must already be listening.
      if (p.content === 'early') { done('success', '提前完成'); reply(id, { accepted: true }); return; }
      reply(id, method === 'session/compact' ? { compact: { state: 'accepted', inputId: p.inputId } } : { accepted: true });
      if (p.content === 'crash') return process.exit(7);
      if (p.content === 'slow') return;
      if (p.content === 'fail') { emit('turn.failed', { error: { message: '模型请求失败' } }); turn = null; return; }
      if (p.content === 'approve' || p.content === 'invalid-approval') {
        const response = await request('interaction/requestPermission', { sessionId, reason: '运行命令', toolName: 'Bash', input: { command: 'pwd' }, options: [{ optionId: 'once', name: '允许一次', kind: 'allow_once', response: { decision: 'allow' } }, { optionId: 'deny', name: '拒绝', kind: 'reject_once', response: { decision: 'deny' } }] });
        if (turn !== activeTurn) return;
        done('success', response?.decision === 'allow' ? '已批准' : '已拒绝'); return;
      }
      emit('model.streaming', { kind: 'reasoning_delta', delta: '先检查' });
      // Other sessions and old turns must not leak into the active turn.
      emit('model.streaming', { kind: 'text_delta', delta: '不应出现' }, 'old-turn');
      if (p.content === 'tool') {
        emit('tool.updated', { kind: 'scheduled', toolCallId: 'tool-1', toolName: 'Read', input: { file_path: 'README.md' } });
        emit('tool.updated', { kind: 'result', toolCallId: 'tool-1', result: { success: true, output: 'hello' } });
      }
      emit('model.streaming', { kind: 'text_delta', delta: method === 'session/compact' ? '已压缩' : '你好' });
      // part.delta is the other delivery surface and must not duplicate model.streaming.
      emit('part.delta', { field: 'text', delta: '你好', partId: 'part-1' });
      done(); return;
    }
    default: error(id, `Unsupported method: ${method}`);
  }
}
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  void handle(JSON.parse(line)).catch((e) => { process.stderr.write(String(e)); process.exit(1); });
});
