import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { coordinationSettings } from '../src/api.js';

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const composer = readFileSync(new URL('../src/components/Composer.tsx', import.meta.url), 'utf8');
const between = (source: string, start: string, end: string) => {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `source boundary ${start}`);
  return source.slice(from, to);
};
const evaluate = (source: string, context: Record<string, any>, result: string) => {
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function('context', `with (context) { ${js}; return ${result}; }`)(context);
};
const initializers = between(app, '  const createDraftThread =', '  const send =')
  + between(app, '  const startDraftVoice =', '  // The address follows');
const navigation = between(app, '  useEffect(() => {\n    setAgentsOpen(false);', '  const onSettings =');

function fixture() {
  const calls: string[] = [];
  const drafts = new Map<string, any>([['host:machine:new', { text: 'unsent words', disabledAgents: ['helper'], notes: [] }]]);
  let fail = false;
  const context: Record<string, any> = {
    selectedId: null, selected: null, hostId: 'machine', composerDraftKey: 'host:machine:new',
    coordination: null, draftCollaboration: true, collaborationDirectories: ['/project', '/other'],
    draftTeam: null, draftWriting: null, draftAgent: 'lead', draftCwd: '/project', draftPermission: 'auto_edit',
    draftWorkMode: 'execute', draftModel: null, draftEffort: null, draftSpeed: null, draftSectionId: null,
    draftScratch: false, beside: null, draftWorktree: false, offer: null, memberPermission: 'full_access', startingDefaults: {},
    consumeDraftWarmup: () => undefined, createdDraftScope: { current: null }, stickToBottom: { current: false },
    draftTransferSource: { current: { key: 'host:machine:new', transfer: (key: string) => {
      calls.push('transfer'); drafts.set(key, drafts.get('host:machine:new')); drafts.delete('host:machine:new');
    } } },
    setThreads: () => {}, setDraftSectionId: () => {}, setDraftWorktree: () => {}, setDraftWriting: () => {},
    setSelectedId: (id: string) => {
      calls.push('select'); context.selectedId = id; context.composerScope.current.selectedId = id;
      context.composerDraftKey = `host:machine:${id}`; context.composerScope.current.draftKey = context.composerDraftKey;
    },
    setCoordination: (value: unknown) => { context.coordination = value; },
    setVoiceOnSelect: (id: string) => { calls.push('arm-voice'); context.armed = id; },
    setError: () => {}, setErrorState: (value: unknown) => { context.error = value; },
    handleError: () => {}, refreshThreads: async () => {},
    setAgentsOpen: () => {}, setDraftCollaboration: (value: boolean) => { context.draftCollaboration = value; },
    setCollaborationDirectories: (value: string[]) => { context.collaborationDirectories = value; },
    useEffect: (run: () => void) => run(),
    voice: { start: async () => { calls.push('voice-start'); } },
    readDrafts: () => Object.fromEntries(drafts), localStorage: {},
    t: (key: string) => key, message: (error: Error) => error.message,
    DemoError: class extends Error {}, AuthError: class extends Error {}, ApiError: class extends Error {},
    collaborationMembers: () => [], coordinationSettings, showcase: null,
  };
  context.api = {
    createThread: async () => { calls.push('create'); return { id: 'root', agent: 'lead', cwd: '/project' }; },
    configureCoordination: async () => assert.fail('manual send and voice must not save retired object policy'),
    startTurn: async (id: string, text: string, _images: unknown, opts: unknown) => {
      calls.push('send'); context.sent = opts; context.sentId = id; context.sentText = text;
      if (fail) { fail = false; throw new Error('send refused'); }
    },
  };
  context.composerScope = { current: { selectedId: null, hostId: 'machine', api: context.api, draftKey: context.composerDraftKey } };
  return { context, calls, drafts, failNext: () => { fail = true; }, functions: () => evaluate(initializers, context, '({ createDraftThread, performSend, startDraftVoice, startVoice })') };
}

// Voice creation only migrates the originating draft before arming the selected session.
test('first voice creation transfers the draft without saving legacy policy or sending text', async () => {
  const f = fixture();
  const source = f.drafts.get('host:machine:new');
  await f.functions().startDraftVoice();
  assert.deepEqual(f.calls, ['create', 'transfer', 'select', 'arm-voice']);
  assert.equal(f.drafts.has('host:machine:new'), false);
  assert.equal(f.drafts.get('host:machine:root'), source);
  assert.equal(f.context.armed, 'root');
  assert.equal(f.calls.includes('send'), false);
});

// React may commit the new selection after the create continuation; the guarded origin can arm it.
test('first voice creation can arm its returned session before selection has committed', async () => {
  const f = fixture();
  f.context.setSelectedId = (id: string) => { f.calls.push('select'); f.context.requestedSelection = id; };
  await f.functions().startDraftVoice();
  assert.deepEqual(f.calls, ['create', 'transfer', 'select', 'arm-voice']);
  assert.equal(f.context.requestedSelection, 'root'); assert.equal(f.context.armed, 'root');
  assert.equal(f.context.composerScope.current.selectedId, null);
  assert.equal(f.context.composerScope.current.draftKey, 'host:machine:new');
  assert.deepEqual(f.context.createdDraftScope.current, { id: 'root', hostId: 'machine' });
});

// A failed create leaves the original draft and setup available for an ordinary voice retry.
test('failed first voice creation keeps the source draft and retries without object policy', async () => {
  const f = fixture();
  const create = f.context.api.createThread, source = f.drafts.get('host:machine:new');
  f.context.api.createThread = async () => { f.calls.push('create'); throw new Error('create refused'); };
  await f.functions().startDraftVoice();
  assert.equal(f.context.selectedId, null);
  assert.equal(f.context.error.text, 'create refused');
  assert.equal(f.drafts.get('host:machine:new'), source);
  assert.deepEqual(f.context.collaborationDirectories, ['/project', '/other']);
  assert.equal(f.calls.includes('arm-voice'), false);
  f.context.api.createThread = create;
  await f.functions().startDraftVoice();
  assert.deepEqual(f.calls, ['create', 'create', 'transfer', 'select', 'arm-voice']);
  assert.equal(f.calls.includes('send'), false);
});

// Initial selection is migration, not navigation; only failed first-send setup needs to survive.
test('failed first send retains manual collaboration setup and retries the existing root', async () => {
  const f = fixture(); f.failNext();
  await assert.rejects(f.functions().performSend('first task', [], true, []), /send refused/);
  evaluate(navigation, f.context, 'undefined');
  assert.equal(f.context.draftCollaboration, true);
  assert.deepEqual(f.context.collaborationDirectories, ['/project', '/other']);
  assert.deepEqual(f.context.createdDraftScope.current, { id: 'root', hostId: 'machine' });
  await f.functions().performSend('first task', [], true, []);
  assert.equal(f.calls.filter(call => call === 'create').length, 1);
  assert.equal(f.calls.filter(call => call === 'send').length, 2);
  assert.deepEqual(f.context.sent.collaboration.directories, ['/project', '/other']);
  assert.equal(f.context.createdDraftScope.current, null);
  assert.equal(f.context.draftCollaboration, false);
  assert.deepEqual(f.context.collaborationDirectories, []);
});

// Real thread/machine navigation must still discard App-only source setup.
test('navigation to another root or machine clears the initial source options', () => {
  for (const change of [{ selectedId: 'other', hostId: 'machine' }, { selectedId: 'root', hostId: 'other-machine' }]) {
    const f = fixture(); f.context.createdDraftScope.current = { id: 'root', hostId: 'machine' };
    Object.assign(f.context, change);
    evaluate(navigation, f.context, 'undefined');
    assert.equal(f.context.draftCollaboration, false); assert.deepEqual(f.context.collaborationDirectories, []);
    assert.equal(f.context.createdDraftScope.current, null);
  }
});

// Starting voice remains an ordinary session action, guarded only by its current thread/API scope.
test('voice start does not act on a stale selection or machine', async () => {
  for (const scope of [{ selectedId: 'other' }, { api: {} }]) {
    const f = fixture(); f.context.selectedId = 'root';
    Object.assign(f.context.composerScope.current, { selectedId: 'root', ...scope });
    await f.functions().startVoice();
    assert.equal(f.calls.includes('voice-start'), false);
  }
});

// The transfer uses the live draft, including typing newer than the durable debounce snapshot.
test('composer transfers live unsent content and cleanup does not resurrect its old new key', () => {
  const kept = new Map<string, any>();
  const live = { text: 'latest typing', notes: [], images: [], references: [], mentions: [], sending: { text: 'outgoing', after: null } };
  const context: Record<string, any> = {
    draftKey: 'host:machine:new', keyRef: { current: 'host:machine:new' }, draftRef: { current: live },
    pendingSend: { current: { key: 'host:machine:new', targetKey: 'host:machine:new' } }, loadDraft: (key: string) => kept.get(key),
    transferredDraftKey: { current: null }, keepDraft: (key: string, draft: unknown) => { if (draft) kept.set(key, draft); else kept.delete(key); },
  };
  const transfer = evaluate(between(composer, '  const transferDraft =', '  useLayoutEffect(() => { onDraftTransfer'), context, 'transferDraft');
  transfer('host:machine:root');
  assert.equal(kept.get('host:machine:root'), live);
  assert.equal(context.transferredDraftKey.current, 'host:machine:new');
  Object.assign(context, { draftKey: 'host:machine:new', leavingNew: false, draft: live });
  const cleanup = between(composer, '      const transferred = transferredDraftKey.current', '\n    };\n  }, [draftKey]);');
  evaluate(cleanup, context, 'undefined');
  assert.equal(kept.has('host:machine:new'), false);
});

// A delayed ordinary or voice creation belongs to its original draft, not the box selected while waiting.
test('delayed first creation transfers to returned root without navigating or mutating another draft', async () => {
  for (const voice of [false, true]) for (const switchMachine of [false, true]) {
    const f = fixture(); if (!voice) f.failNext();
    const source = f.drafts.get('host:machine:new');
    let release!: (thread: unknown) => void;
    f.context.api.createThread = () => { f.calls.push('create'); return new Promise(resolve => { release = resolve; }); };
    const functions = f.functions();
    const pending = voice ? functions.startDraftVoice() : functions.performSend('unsent words', [], true, []);
    const other = { text: 'other words', notes: [] };
    const otherKey = switchMachine ? 'host:other-machine:B' : 'host:machine:B';
    f.drafts.set(otherKey, other);
    f.context.selectedId = 'B'; f.context.composerDraftKey = otherKey;
    Object.assign(f.context.composerScope.current, { selectedId: 'B', draftKey: otherKey, ...(switchMachine ? { hostId: 'other-machine', api: {} } : {}) });
    f.context.draftTransferSource.current = { key: otherKey, transfer: () => assert.fail('must not transfer B') };
    release({ id: 'root', agent: 'lead', cwd: '/project' });
    if (voice) await pending;
    else { await assert.rejects(pending, /send refused/); assert.equal(f.context.error.thread, 'root'); }
    assert.equal(f.context.selectedId, 'B');
    assert.equal(f.drafts.get(otherKey), other);
    assert.equal(f.drafts.get('host:machine:root'), source);
    assert.equal(f.drafts.has('host:machine:new'), false);
    assert.equal(f.calls.includes('select'), false); assert.equal(f.calls.includes('arm-voice'), false);
    assert.equal(f.context.createdDraftScope.current, null);
  }
});

// Explicit collaboration activation loads saved-only settings even before the detailed view arrives.
test('explicit send activation retains saved-only settings instead of device preferences', async () => {
  for (const loaded of [false, true]) {
    const f = fixture();
    const saved = { rootId: 'root', enabled: false, directories: ['/saved'], defaults: { helper: { model: 'saved', effort: 'low' } }, permission: 'read_only', members: [] };
    f.context.selectedId = 'root'; f.context.selected = { id: 'root', coordination: { enabled: false, rootId: 'root' } };
    f.context.coordination = loaded ? saved : null;
    f.context.api.coordination = async () => { f.calls.push('load-policy'); return saved; };
    await f.functions().performSend('activate', [], false);
    assert.deepEqual(f.context.sent.collaboration, { directories: ['/saved'], defaults: saved.defaults, permission: 'read_only' });
    assert.equal(f.calls.includes('load-policy'), !loaded);
  }
});

// Missing authority is not permission to silently activate an existing restricted root with device defaults.
test('explicit collaboration activation cannot replace an unavailable saved view with device defaults', async () => {
  const f = fixture(); f.context.selectedId = 'root'; f.context.selected = { coordination: { enabled: false } };
  f.context.api.coordination = async () => null;
  await assert.rejects(f.functions().performSend('activate', [], false), /collab.loadFailed/);
  assert.equal(f.calls.includes('send'), false);
});

// The explicit settings Enable action uses the same authoritative root values as first-send activation.
test('settings Enable reloads authoritative root policy before configuring collaboration', async () => {
  const f = fixture(); f.context.selected = { id: 'root', cwd: '/project', coordination: { enabled: false } };
  f.context.composerScope.current.selectedId = 'root';
  const saved = { directories: ['/saved'], defaults: {}, permission: 'read_only' };
  f.context.api.coordination = async () => { f.calls.push('load-policy'); return saved; };
  f.context.api.configureCoordination = async (id: string, body: unknown) => { assert.equal(id, 'root'); f.calls.push('enable'); assert.deepEqual(body, saved); return saved; };
  f.context.close = () => f.calls.push('close');
  const body = between(app, '              const saved = await api.coordination(selected.id);', '\n            })().catch(handleError);');
  await evaluate(`const enable = async () => { ${body} };`, f.context, 'enable')();
  assert.deepEqual(f.calls, ['load-policy', 'enable', 'close']);
});

// Thread eligibility and retired fields cannot lock manual text, queued sends, or ordinary voice.
test('manual chat and voice ignore disabled sessions and unavailable legacy coordination views', async () => {
  for (const loaded of [false, true]) {
    const f = fixture();
    f.context.selectedId = 'root'; f.context.draftCollaboration = false;
    f.context.selected = { id: 'root', disabled: true, coordination: { rootId: 'root', enabled: false } };
    f.context.coordination = loaded ? { rootId: 'root', enabled: false, disabledAgents: ['helper'], members: [{ id: 'member', disabled: true, effectiveDisabled: true, agentRef: 'helper', thread: { disabled: true } }] } : null;
    f.context.api.coordination = async () => assert.fail('ordinary manual chat must not load collaboration policy');
    f.context.composerScope.current.selectedId = 'root';
    await f.functions().performSend('manual words', [], false, []);
    await f.functions().startVoice();
    assert.deepEqual(f.calls, ['send', 'voice-start']);
    assert.equal(f.context.sentId, 'root'); assert.equal(f.context.sentText, 'manual words');
    assert.equal(f.context.sent.queue, true); assert.equal(f.context.sent.collaboration, undefined);
  }
});

// Captured transfer callbacks use their durable source, never the composer now on screen.
test('composer origin transfer uses durable source without changing the visible draft', () => {
  const source = { text: 'source', notes: [{ quote: 'passage', comment: 'why' }], references: [{ id: 'folder' }], mentions: [{ id: 'helper' }], sending: { text: 'source', after: null } };
  const other = { text: 'other', notes: [] };
  const kept = new Map<string, any>([['host:machine:new', source], ['host:machine:B', other]]);
  const context: Record<string, any> = {
    keyRef: { current: 'host:machine:B' }, draftRef: { current: other }, transferredDraftKey: { current: null },
    pendingSend: { current: { key: 'host:machine:new', targetKey: 'host:machine:new' } }, loadDraft: (key: string) => kept.get(key),
    keepDraft: (key: string, draft: unknown) => { if (draft) kept.set(key, draft); else kept.delete(key); },
  };
  const transferSource = between(composer, '  const transferDraft =', '  useLayoutEffect(() => { onDraftTransfer');
  const transfer = evaluate(`const draftKey = 'host:machine:new'; ${transferSource}`, context, 'transferDraft');
  transfer('host:machine:root');
  assert.equal(kept.get('host:machine:root'), source); assert.equal(kept.has('host:machine:new'), false);
  assert.equal(context.pendingSend.current.targetKey, 'host:machine:root');
  assert.equal(kept.get('host:machine:B'), other); assert.equal(context.draftRef.current, other);
  assert.equal(context.transferredDraftKey.current, null);
  transfer('host:machine:another');
  assert.equal(kept.has('host:machine:another'), false, 'a stale callback cannot duplicate its already-transferred source');
});

// Source cleanup removes old object policy and input-lock wiring without inspecting unrelated features.
test('App and Composer expose only generic draft transfer rather than disabled-agent policy', () => {
  assert.doesNotMatch(app, /\b(?:saveDraftPolicy|draftPolicyBusy|draftPolicySource|objectScope|changeObjectDisabled|disabledAgents|mentionDisabled|withDraftDisabledAgents|collaborationObjectActions|onObjectMenu|effectiveDisabled|agentRef)\b|object-disabled/);
  assert.doesNotMatch(composer, /\b(?:ComposerDraftPolicy|onDraftPolicy|disabledAgents|setDisabledAgents|mentionDisabled|blockedMention|blockedMentions|onObjectMenu|selectableCollaborators|CollaborationObject)\b/);
  assert.match(composer, /onDraftTransfer\?:\s*\(transfer:\s*\(targetKey:\s*string\)\s*=>\s*void\)\s*=>\s*void/);
  assert.match(app, /\bexplicitDraftTransfer\b/);
});

// Main Composer binds the old first-message heuristic to the explicitly returned root; other callers remain compatible.
test('explicit first-message migration never treats unrelated navigation as the created target', () => {
  const section = between(composer, '    const pending = pendingSend.current;\n    const firstMessage =', '    const saved = loadDraft(draftKey)');
  const pending = { dispatching: true, key: 'new', targetKey: 'A' };
  for (const [draftKey, explicitDraftTransfer, expected] of [['B', true, false], ['A', true, true], ['B', false, true]]) {
    const value = evaluate(section, { pendingSend: { current: pending }, previous: 'new', draftKey, explicitDraftTransfer }, 'firstMessage');
    assert.equal(value, expected);
  }
});
