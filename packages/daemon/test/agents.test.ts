import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRegistry, defaultInstances, type AgentInstance } from '../src/agents.js';
import { HttpError } from '../src/errors.js';

const here = dirname(fileURLToPath(import.meta.url));

const defaults = defaultInstances({
  claudeCommand: ['node', join(here, 'fixtures', 'fake-acp.mjs')],
  piCommand: ['node', join(here, 'fixtures', 'fake-pi.mjs')],
  agyCommand: ['node', join(here, 'fixtures', 'fake-agy.mjs')],
  traexCommand: ['node', join(here, 'fixtures', 'fake-acp.mjs'), 'acp', 'serve'],
  codexCommand: ['node', join(here, 'fixtures', 'fake-codex.mjs')],
});

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'rah-agents-'));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('the built-in instances are one adapter each, keyed by instance id', () => {
  const registry = new AgentRegistry(defaults, null);
  assert.deepEqual([...registry.adapters.keys()].sort(), ['agy', 'claude', 'codex', 'pi', 'traex']);
  assert.equal(registry.adapters.get('claude')!.capabilities.approvals, true);
  // The traex default command carries "acp serve"; the adapter keeps the plain CLI for deletions.
  assert.equal(registry.adapters.get('traex')!.label, 'TRAE CLI');
  assert.equal(registry.adapters.get('traex')!.resumeCommand('s1'), 'traex resume s1');
});

test('fromEnv prefers agents.json over the defaults, and instance labels reach the adapter', () => {
  const extra: AgentInstance[] = [...defaults, { id: 'pi2', adapter: 'pi', label: 'pi 备用', env: { FAKE_PI_LABEL: 'pi2' } }];
  const registry = new AgentRegistry(extra, null);
  const adapter = registry.adapters.get('pi2');
  assert.ok(adapter);
  assert.equal(adapter.label, 'pi 备用');
});

test('add persists to agents.json and a later fromEnv reads it back', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rah-agents-env-'));
  const registry = AgentRegistry.fromEnv({ dataDir, env: {}, defaults });
  await registry.add({ id: 'agy2', adapter: 'agy', command: ['/opt/agy2/bin/agy2'] });
  assert.ok(registry.adapters.has('agy2'));

  const reloaded = AgentRegistry.fromEnv({
    dataDir,
    env: {},
    defaults: defaultInstances({ claudeCommand: ['claude-agent-acp'], piCommand: ['pi'], agyCommand: ['agy'], traexCommand: ['traex', 'acp', 'serve'], codexCommand: ['codex', 'app-server'] }),
  });
  // The file holds every instance, including the built-ins it was seeded with.
  assert.deepEqual(
    reloaded.list().map((i) => i.id),
    ['claude', 'pi', 'agy', 'traex', 'codex', 'agy2'],
  );
  rmSync(dataDir, { recursive: true, force: true });
});

test('add refuses unknown adapters, duplicate ids and junk ids', async () => {
  const registry = new AgentRegistry(defaults, null);
  await assert.rejects(registry.add({ adapter: 'codex' }), HttpError);
  await assert.rejects(registry.add({ id: 'pi', adapter: 'pi' }), HttpError);
  await assert.rejects(registry.add({ id: 'not a name!', adapter: 'pi' }), HttpError);
  // An id can come from the command's basename when none is given.
  const made = await registry.add({ adapter: 'pi', command: ['/opt/bin/claude2'] });
  assert.equal(made.id, 'claude2');
});

test('an instance without a command inherits its adapter default', async () => {
  const registry = new AgentRegistry(defaults, null);
  const second = await registry.add({ id: 'claude2', adapter: 'claude', env: { CLAUDE_CONFIG_DIR: '/tmp/claude-b' } });
  assert.equal(second.command, undefined);
  assert.ok(registry.adapters.has('claude2'));
});

test('discover finds extra CLIs on PATH and leaves lookalikes alone', async () => {
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const oldPath = process.env.PATH;
  for (const name of ['agy2', 'claude2', 'ping', 'pix', 'pi', 'traecli']) {
    writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, name), 0o755);
  }
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const found = await new AgentRegistry(defaults, null).discover();
    // 'pi' is already a configured instance; 'ping' and 'pix' only look like pi. Other CLIs may
    // exist elsewhere on this machine's PATH, so only the ones from our bin directory count here.
    const ours = found.filter((f) => f.command.startsWith(bin));
    assert.deepEqual(
      ours.map((f) => f.id),
      ['agy2', 'claude2', 'traecli'],
    );
    assert.equal(ours[0].adapter, 'agy');
    assert.equal(ours[2].adapter, 'traex', "traecli is traex's compatibility name");
  } finally {
    process.env.PATH = oldPath;
  }
});

// The stub claude the account-discovery tests point the adapter at: it answers `auth status`
// from the config directory it was given, so each directory below stands for one account.
function fakeClaudeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'rah-accounts-home-'));
  for (const name of ['.claude', '.claude-2', '.claude-3', '.claude-out', '.claude-broken']) {
    mkdirSync(join(home, name));
  }
  return home;
}

function fakeClaudeBin(home: string): string {
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const script = join(bin, 'claude');
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      'name=$(basename "$CLAUDE_CONFIG_DIR")',
      'case "$name" in',
      "  .claude-out) echo '{\"loggedIn\":false}' ;;",
      '  .claude-broken) echo "not json" ;;',
      "  *) printf '{\"loggedIn\":true,\"email\":\"%s@%s\"}\n' \"$name\" \"$(echo \"$name\" | tr -d .)\" ;;",
      'esac',
    ].join('\n'),
  );
  chmodSync(script, 0o755);
  return script;
}

test('account discovery offers signed-in accounts no instance uses', async () => {
  const home = fakeClaudeHome();
  const oldBin = process.env.RAH_CLAUDE_BIN;
  const oldHome = process.env.HOME;
  process.env.RAH_CLAUDE_BIN = fakeClaudeBin(home);
  process.env.HOME = home;
  try {
    // The built-in claude has no env of its own, so it claims the default account (~/.claude);
    // the logged-out and unparseable directories answer nothing usable.
    const found = await new AgentRegistry(defaults, null).discoverAccounts();
    assert.deepEqual(found, [
      {
        adapter: 'claude',
        email: '.claude-2@claude-2',
        env: { CLAUDE_CONFIG_DIR: join(home, '.claude-2') },
        id: 'claude-2',
        label: 'Claude Code 2',
      },
      {
        adapter: 'claude',
        email: '.claude-3@claude-3',
        env: { CLAUDE_CONFIG_DIR: join(home, '.claude-3') },
        id: 'claude-3',
        label: 'Claude Code 3',
      },
    ]);
  } finally {
    if (oldBin === undefined) delete process.env.RAH_CLAUDE_BIN;
    else process.env.RAH_CLAUDE_BIN = oldBin;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test('account discovery skips accounts an instance already links, and ids keep counting', async () => {
  const home = fakeClaudeHome();
  const oldBin = process.env.RAH_CLAUDE_BIN;
  const oldHome = process.env.HOME;
  process.env.RAH_CLAUDE_BIN = fakeClaudeBin(home);
  process.env.HOME = home;
  try {
    const instances: AgentInstance[] = [
      ...defaults,
      { id: 'claude-2', adapter: 'claude', env: { CLAUDE_CONFIG_DIR: join(home, '.claude-2') } },
    ];
    const found = await new AgentRegistry(instances, null).discoverAccounts();
    // .claude is claimed by the built-in, .claude-2 by the linked instance; claude-2 is taken,
    // so the suggestion for .claude-3 moves on to claude-3 / "Claude Code 3".
    assert.deepEqual(found, [
      {
        adapter: 'claude',
        email: '.claude-3@claude-3',
        env: { CLAUDE_CONFIG_DIR: join(home, '.claude-3') },
        id: 'claude-3',
        label: 'Claude Code 3',
      },
    ]);
  } finally {
    if (oldBin === undefined) delete process.env.RAH_CLAUDE_BIN;
    else process.env.RAH_CLAUDE_BIN = oldBin;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});
