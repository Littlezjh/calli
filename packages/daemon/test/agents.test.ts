import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  assert.deepEqual([...registry.adapters.keys()].sort(), ['agy', 'claude', 'codex', 'pi', 'traex', 'zcode']);
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
    ['claude', 'pi', 'agy', 'traex', 'codex', 'zcode', 'agy2'],
  );
  rmSync(dataDir, { recursive: true, force: true });
});

test('update renames and remove drops an instance from agents.json', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rah-agents-manage-'));
  const registry = AgentRegistry.fromEnv({ dataDir, env: {}, defaults });
  await registry.add({ id: 'agy2', adapter: 'agy', command: ['/opt/agy2/agy2'] });

  const renamed = await registry.update('agy2', { label: '备用号' });
  assert.equal(renamed.label, '备用号');
  assert.equal(registry.adapters.get('agy2')!.label, '备用号');
  const reloaded = AgentRegistry.fromEnv({ dataDir, env: {}, defaults });
  assert.equal(reloaded.list().find((i) => i.id === 'agy2')?.label, '备用号');

  await registry.remove('agy2');
  assert.equal(registry.adapters.has('agy2'), false);
  const after = AgentRegistry.fromEnv({ dataDir, env: {}, defaults });
  assert.equal(after.list().some((i) => i.id === 'agy2'), false);

  await assert.rejects(registry.update('agy2', { label: 'x' }), HttpError);
  await assert.rejects(registry.remove('agy2'), HttpError);
  rmSync(dataDir, { recursive: true, force: true });
});

test('the built-in command survives deleting the instance that supplied it', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rah-agents-builtin-'));
  const registry = AgentRegistry.fromEnv({ dataDir, env: {}, defaults });
  await registry.remove('claude');
  await registry.add({ id: 'claude-2', adapter: 'claude', env: { CLAUDE_CONFIG_DIR: '/tmp/claude-two' } });
  const reloaded = AgentRegistry.fromEnv({ dataDir, env: {}, defaults });
  assert.equal(await reloaded.adapters.get('claude-2')!.available(), true);
  rmSync(dataDir, { recursive: true, force: true });
});

test('adapters that can start a login expose a command in their own environment', () => {
  const registry = new AgentRegistry([
    { id: 'claude', adapter: 'claude', command: ['claude'], env: { CLAUDE_CONFIG_DIR: '/tmp/claude-login' } },
    { id: 'codex', adapter: 'codex', command: ['codex', 'app-server'] },
    { id: 'traex', adapter: 'traex', command: ['traex', 'acp', 'serve'] },
    { id: 'zcode', adapter: 'zcode', command: ['zcode'] },
    { id: 'pi', adapter: 'pi', command: ['pi'] },
    { id: 'agy', adapter: 'agy', command: ['agy'] },
  ], null);
  assert.match(registry.adapters.get('claude')!.loginCommand!(), /CLAUDE_CONFIG_DIR='\/tmp\/claude-login'.*auth login/);
  assert.match(registry.adapters.get('codex')!.loginCommand!(), /login --device-auth/);
  assert.match(registry.adapters.get('traex')!.loginCommand!(), /login --sso-device/);
  assert.match(registry.adapters.get('zcode')!.loginCommand!(), /login --no-browser/);
  assert.equal(registry.adapters.get('pi')!.loginCommand, undefined);
  assert.equal(registry.adapters.get('agy')!.loginCommand, undefined);
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

test('discover lists one row per executable and skips aliases an instance already uses', async () => {
  const bin = join(dir, 'alias-bin');
  mkdirSync(bin);
  const target = join(bin, 'traex');
  writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // The installer's compatibility names are symlinks to the same executable.
  for (const name of ['coco', 'ta', 'trae-agent', 'trae-cli', 'traecli']) {
    symlinkSync('traex', join(bin, name));
  }
  // Separate programs whose names start with an agent's name are not copies of it.
  for (const name of ['claude-agent-acp', 'traex-bridge']) {
    writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    // Without a TRAE instance, the aliases collapse to the CLI's own name.
    const fresh = new AgentRegistry(defaults.filter((i) => i.adapter !== 'traex'), null);
    const offered = (await fresh.discover()).filter((f) => f.command.startsWith(bin));
    assert.deepEqual(offered.map((f) => f.id), ['traex']);

    // Once an instance runs that executable, none of its aliases are offered.
    const used = new AgentRegistry([
      ...defaults.filter((i) => i.adapter !== 'traex'),
      { id: 'traex', adapter: 'traex', command: [target, 'acp', 'serve'] },
    ], null);
    assert.deepEqual((await used.discover()).filter((f) => f.command.startsWith(bin)), []);
  } finally {
    process.env.PATH = oldPath;
  }
});

test('discover offers zcode for existing installations and add makes it available', async () => {
  const bin = join(dir, 'zcode-bin');
  mkdirSync(bin);
  for (const name of ['zcode', 'zcode-2', 'zcodec']) {
    writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, name), 0o755);
  }
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const registry = new AgentRegistry(defaults.filter((i) => i.adapter !== 'zcode'), null);
    const found = (await registry.discover()).filter((f) => f.command.startsWith(bin));
    assert.deepEqual(found.map((f) => [f.id, f.adapter]), [['zcode', 'zcode'], ['zcode-2', 'zcode']]);
    await registry.add({ id: found[0].id, adapter: found[0].adapter, command: [found[0].command] });
    assert.equal(await registry.adapters.get('zcode')!.available(), true);
    assert.equal((await registry.discover()).some((f) => f.id === 'zcode'), false);
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

test('account discovery still sees an adapter after every instance of it is removed', async () => {
  const home = fakeClaudeHome();
  const oldBin = process.env.RAH_CLAUDE_BIN;
  const oldHome = process.env.HOME;
  process.env.RAH_CLAUDE_BIN = fakeClaudeBin(home);
  process.env.HOME = home;
  try {
    const registry = new AgentRegistry(defaults.filter((i) => i.adapter !== 'claude'), null, defaults);
    const found = await registry.discoverAccounts();
    assert.deepEqual(found.map((a) => a.id).sort(), ['claude', 'claude-2', 'claude-3']);
    assert.equal(found.find((a) => a.id === 'claude')?.label, 'Claude Code');
    assert.equal(found.find((a) => a.id === 'claude-3')?.label, 'Claude Code 3');
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

test('supported lists all built-in adapters with labels and install guides', () => {
  const registry = new AgentRegistry(defaults, null);
  const supported = registry.supported();
  assert.equal(supported.length, 6);
  const adapters = supported.map((s) => s.adapter);
  assert.deepEqual(adapters, ['claude', 'codex', 'pi', 'agy', 'traex', 'zcode']);
  for (const item of supported) {
    assert.ok(item.label, `adapter ${item.adapter} has a label`);
    assert.ok(item.icon, `adapter ${item.adapter} has an icon`);
  }
  assert.equal(supported.find((s) => s.adapter === 'claude')?.installGuide, 'npm install -g @anthropic-ai/claude-code');
  assert.equal(supported.find((s) => s.adapter === 'codex')?.installGuide, 'npm install -g @openai/codex');
  assert.equal(supported.find((s) => s.adapter === 'pi')?.installGuide, 'npm install -g @mariozechner/pi-coding-agent');
  assert.equal(supported.find((s) => s.adapter === 'agy')?.installGuide, undefined);
  assert.equal(supported.find((s) => s.adapter === 'traex')?.installGuide, undefined);
  assert.equal(supported.find((s) => s.adapter === 'zcode')?.installGuide, undefined);
});

test('AgentRegistry.fromEnv supports an explicitly empty agents array', () => {
  const registry = AgentRegistry.fromEnv({
    dataDir: dir,
    env: { RAH_AGENTS_JSON: JSON.stringify({ agents: [] }) },
    defaults,
  });
  assert.deepEqual(registry.list(), []);
});
