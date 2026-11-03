import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ClaudeAcpAdapter } from '../src/adapters/claude.js';
import { RpcError } from '../src/adapters/jsonrpc.js';

const here = dirname(fileURLToPath(import.meta.url));
const command = [process.execPath, join(here, 'fixtures/fake-acp.mjs')];

test('Claude gateway model listing defers access validation until selection', async () => {
  const adapter = new ClaudeAcpAdapter(command, { ANTHROPIC_BASE_URL: 'http://gateway.invalid' });
  const models = await adapter.models();
  assert.deepEqual(models.map(model => model.id), ['default', 'big', 'small', 'broken']);
  await assert.rejects(adapter.start({ cwd: here, model: 'broken' }), error => error instanceof RpcError && error.code === -32603);
});
