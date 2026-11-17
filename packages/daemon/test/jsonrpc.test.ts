import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { JsonRpcPeer, RpcError } from '../src/adapters/jsonrpc.js';

test('JSON-RPC preserves actionable error details and the native error code', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => true,
  });
  const peer = new JsonRpcPeer(child as unknown as ChildProcessWithoutNullStreams, {
    onNotification: () => undefined, onRequest: () => undefined,
  }, 'fixture');
  const details = 'Could not confirm model "broken" with the API.';
  const cases = [
    { data: { details }, expected: `Internal error\n${details}` },
    { data: { details: '  ' }, expected: 'Internal error' },
    { data: { details: { token: 'do not stringify arbitrary data' } }, expected: 'Internal error' },
    { data: { details: 'Internal error' }, expected: 'Internal error' },
    { data: undefined, expected: 'Internal error' },
  ];
  for (const [index, { data, expected }] of cases.entries()) {
    const request = peer.request('session/new', {});
    const failed = assert.rejects(request, error => {
      assert.ok(error instanceof RpcError);
      assert.equal(error.message, expected);
      assert.equal(error.code, -32603);
      assert.deepEqual(error.data, data);
      return true;
    });
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: index + 1, error: { code: -32603, message: 'Internal error', data } }) + '\n');
    await failed;
  }
  peer.close();
  child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
});

for (const completion of ['result', 'error'] as const) {
  test(`JSON-RPC drops a late incoming handler ${completion} after process exit`, async () => {
    const writes: string[] = [];
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(),
      stdin: new Writable({ write(chunk, _encoding, callback) { writes.push(String(chunk)); callback(); } }),
      kill: () => true,
    });
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    let requested = false;
    const answer = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
    const peer = new JsonRpcPeer(child as unknown as ChildProcessWithoutNullStreams, {
      onNotification: () => undefined,
      onRequest: () => { requested = true; return answer; },
    }, 'fixture');
    const prompt = peer.request('session/prompt', { sessionId: 'fixture' });
    const failed = assert.rejects(prompt, /fixture exited/);
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1000, method: 'session/request_permission', params: {} }) + '\n');
    assert.equal(requested, true);
    child.emit('exit', 9, null);
    await failed;
    assert.equal(peer.isClosed, true);
    const writesAtExit = writes.length;
    if (completion === 'result') resolve({ outcome: { outcome: 'cancelled' } });
    else reject(new Error('permission handler ended after exit'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writes.length, writesAtExit, 'no response or error is written to closed agent stdin');
    child.stdout.destroy();
    child.stderr.destroy();
    child.stdin.destroy();
  });
}
