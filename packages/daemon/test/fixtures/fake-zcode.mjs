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
let goal = null;
let goalRun = false;
const pending = new Map();
const request = (method, params) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); output({ id, method, params }); });
const emit = (type, payload, turnId = turn?.id) => output({ method: 'session/event', params: { sessionId, eventId: `ev-${++seq}`, seq, turnId, type, payload, deliveryKind: 'desktop-continuous' } });
const snapshot = () => ({ session: { sessionId, target: process.env.FAKE_ZCODE_GOAL ? { status: 'active' } : goal }, settings: { mode: { current: mode }, model: { current: model, available: process.env.FAKE_ZCODE_NO_MODELS ? [] : [{ ref: { providerId: 'api', modelId: 'small' }, label: 'Small', reasoning: { defaultLevel: 'low', levels: [{ value: 'low' }, { value: 'high' }] } }, { ref: { providerId: 'api', modelId: 'large' }, label: 'Large' }] } } });
const goalSettled = (failed = false) => { goalRun = false; output({ method: 'state.updated', params: { sessionId, reason: failed ? 'goal_continuation_failed' : 'goal_continuation_completed' } }); };
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
    case 'session/goal': {
      if (process.env.FAKE_ZCODE_NO_GOALS) return error(id, 'goal unsupported');
      if (p.action === 'pause') { if (goal) goal.status = 'paused'; done('cancelled', ''); if (goalRun) goalSettled(); }
      if (p.action === 'clear') goal = null;
      if (p.action === 'set') goal = { objective: p.objective, status: 'active' };
      if (p.action === 'resume' && goal) goal.status = 'active';
      const startedTurn = ['set', 'resume'].includes(p.action) && goal?.status === 'active';
      if (!startedTurn) return reply(id, { snapshot: snapshot(), startedTurn, response: '' });
      goalRun = true;
      const run = async () => {
        for (let round = 1; round <= 2; round++) {
          if (!goalRun) return;
          turn = { id: `goal-${++seq}` };
          emit('turn.started', { inputId: round === 1 ? p.inputId : 'native-continuation' });
          if (goal.objective.includes('crash')) return process.exit(2);
          if (goal.objective.includes('slow')) return;
          if (goal.objective.includes('turn-fail')) {
            emit('turn.failed', { error: { message: '模型请求失败' } }); turn = null;
            await new Promise((r) => setTimeout(r, 20));
            goal.status = 'paused'; goalSettled(true); return;
          }
          if (round === 2 && goal.objective.includes('approve')) {
            const answer = await request('interaction/requestPermission', { sessionId, reason: '目标审批', options: [{ optionId: 'once', name: '允许一次', kind: 'allow_once', response: { decision: 'allow' } }] });
            if (!goalRun) return;
            emit('model.streaming', { kind: 'text_delta', delta: `decision:${answer.decision}` });
          }
          done('success', `目标第 ${round} 轮`);
          await new Promise((r) => setTimeout(r, 20));
        }
        if (!goalRun) return;
        goal.status = 'completed'; goalSettled(goal.objective.includes('fail'));
      };
      void run();
      reply(id, { snapshot: snapshot(), startedTurn, response: '' }); return;
    }
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
    case 'session/usage': return reply(id, { sessionId, totalTokens: 1500, inputTokens: 1200, outputTokens: 300, reasoningTokens: 100, cacheCreationTokens: 200, cacheReadTokens: 700, modelRequestCount: 2, modelErrorCount: 0, inputBaselineBySource: {} });
    case 'session/read': return reply(id, snapshot());
    case 'session/close': reply(id, { closed: true }); return;
    case 'session/stop': reply(id, { stopped: true }); done('cancelled', ''); if (goalRun) { goal.status = 'paused'; goalSettled(); } return;
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
      if (method === 'session/compact') {
        await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_COMPACT_DELAY ?? 20)));
        if (turn !== activeTurn) return;
        if (process.env.FAKE_COMPACT_FAIL) { emit('turn.failed', { error: { message: 'compaction failed' } }); turn = null; return; }
      }
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
