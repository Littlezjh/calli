import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ModuleKind, JsxEmit, transpileModule } from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { ApiError, type Api, type Thread } from '../src/api';
import { useThreadActions } from '../src/components/ThreadActions';
import type { MenuEntry, MenuItem } from '../src/components/Menu';
import { cancellableHandover } from '../src/handover';
import { folderName } from '../src/paths';
import { boardStage, threadAttention } from '../src/sidebar';
import * as icons from '../src/components/icons';
import * as i18n from '../src/i18n';

const noop = () => undefined;
const MenuStub = () => null;
const source = readFileSync(new URL('../src/components/ThreadActions.tsx', import.meta.url), 'utf8');
const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
type Deps = Parameters<typeof useThreadActions>[0];
type Updates = Parameters<Api['updateThread']>[1];

function thread(id: string, extra: Partial<Thread> = {}): Thread {
  return {
    id, title: id, agent: 'writer', cwd: '/workspace', cwdReal: '/workspace', status: 'idle', preview: null,
    agentSessionId: 'session', pinned: false, permissionMode: 'auto_edit', model: null, effort: null, archivedAt: null,
    sectionId: null, forkedFrom: null, unread: false, terminalActivity: false, waiting: false, queued: [], resumeCommand: null,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', ...extra,
  };
}

// Run the actual hook with persistent menu state; dialogs and browser effects are outside this unit.
function fixture(extra: Partial<Deps> = {}) {
  const states: unknown[] = [];
  let cursor = 0, target = thread('initial');
  let failure: Error | null = null;
  const requests: Array<{ id: string; updates: Updates }> = [];
  const changed: Thread[] = [], errors: unknown[] = [], busy: unknown[] = [], archived: Thread[] = [];
  const api = {
    host: 'remote-machine',
    updateThread: async (id: string, updates: Updates) => {
      requests.push({ id, updates: { ...updates } });
      if (failure) throw failure;
      return { ...target, ...updates, updatedAt: '2026-01-03T00:00:00Z' };
    },
  } as Api;
  const modules: Record<string, unknown> = {
    react: { ...React, useState: (initial: unknown) => {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], (next: unknown) => { states[index] = typeof next === 'function' ? next(states[index]) : next; }];
    } },
    'react/jsx-runtime': jsx,
    '../api': { ApiError },
    '../clipboard': { copyText: noop },
    '../thread-deep-links': { threadDeepLink: noop },
    '../paths': { folderName },
    '../handover': { cancellableHandover },
    '../i18n': i18n,
    '../sidebar': { boardStage, threadAttention },
    './icons': icons,
    './Menu': { Menu: MenuStub },
  };
  const children = { ChoiceDialog: noop, Dialog: noop, HandoverChainDialog: noop, HandoverDialog: noop, TakeoverDialog: noop, AgentPicker: noop, ChatQuotaMenu: noop };
  const module = { exports: {} };
  runInNewContext(code, {
    module, exports: module.exports,
    require: (id: string) => {
      if (id in modules) return modules[id];
      if (/^\.\/[A-Z]/.test(id)) return children;
      throw new Error(`Unexpected hook dependency: ${id}`);
    },
  }, { filename: 'ThreadActions.tsx' });
  const deps: Deps = {
    api, agents: [], sections: [], todos: [], onTodosChange: noop, onThreadRemove: noop, onThreadOpen: noop,
    onMarkedUnread: noop, onSectionsChange: noop, onOpenTerminal: noop, onOpenFiles: noop,
    onThreadChange: saved => changed.push(saved), onError: error => errors.push(error), onBusy: value => busy.push(value),
    onArchived: saved => archived.push(saved), markdownOf: async () => '', ...extra,
  };
  const render = () => {
    cursor = 0;
    return (module.exports as { useThreadActions: typeof useThreadActions }).useThreadActions(deps);
  };
  const menu = (value: Thread, where: 'list' | 'page' | 'section' = 'list'): MenuEntry[] => {
    target = value;
    const actions = render();
    if (where === 'section') actions.openSectionMenu({ id: 'section', name: 'Section', position: 0 }, 12, 34);
    else if (where === 'page') actions.openPageMenu(value, 12, 34);
    else actions.openThreadMenu(value, 12, 34);
    const layer = render().layer as React.ReactElement<{ children: React.ReactNode }>;
    const node = React.Children.toArray(layer.props.children).find(node => React.isValidElement(node) && node.type === MenuStub);
    assert.ok(React.isValidElement<{ items: MenuEntry[] }>(node));
    return Array.from(node.props.items);
  };
  return { menu, requests, changed, errors, busy, archived, fail: (error: Error) => { failure = error; } };
}

const ids = (items: MenuEntry[]) => items.map(item => item === 'separator' ? item : item.id);
const toggles = (items: MenuEntry[]): MenuItem[] => items.filter((item): item is MenuItem => item !== 'separator' && (item.id === 'disable' || item.id === 'enable'));
async function select(item: MenuItem) {
  assert.ok(item.onSelect);
  item.onSelect();
  await new Promise<void>(resolve => setImmediate(resolve));
}

// Current members patch their own exact ID through the scoped API, not their lead, instance or handover chain.
test('sidebar collaboration toggle saves exact current member and handover member IDs', async () => {
  const predecessor = thread('predecessor', { coordination: { rootId: 'root', children: 0, paused: false, retired: true } });
  const latest = thread('latest', { coordination: { rootId: 'root', children: 0, paused: false }, handover: { sourceId: predecessor.id, title: predecessor.title, agent: predecessor.agent } });
  const rows = [thread('member', { coordination: { rootId: 'root', children: 0, paused: false } }), latest];
  for (const row of rows) {
    for (const disabled of [false, true]) {
      const f = fixture({ chain: { threads: [predecessor, latest], isMerged: () => true, onToggle: noop, onSelect: noop, onRefresh: noop } });
      const original = { ...row, disabled };
      const [item] = toggles(f.menu(original));
      assert.equal(item.id, disabled ? 'enable' : 'disable');
      await select(item);
      assert.deepEqual(f.requests, [{ id: row.id, updates: { disabled: !disabled } }]);
      assert.equal(f.changed.length, 1);
      assert.deepEqual(f.changed[0], { ...original, disabled: !disabled, updatedAt: '2026-01-03T00:00:00Z' });
      assert.equal(original.disabled, disabled, 'no optimistic mutation of the row');
      assert.equal(toggles(f.menu(f.changed[0]))[0].id, disabled ? 'disable' : 'enable');
      assert.deepEqual(f.errors, []);
      assert.deepEqual(f.busy, []);
      assert.deepEqual(f.archived, []);
    }
  }
});

// Ordinary mains have no coordination record; retired lead predecessors also cannot opt out as current seats.
test('ordinary mains and retired conversations never offer collaboration switches', () => {
  const f = fixture({ onNewBeside: noop, autotitle: true, board: true });
  for (const disabled of [false, true]) {
    for (const archivedAt of [null, '2026-01-03T00:00:00Z']) {
      const expected = ids(f.menu(thread('control', { archivedAt })));
      const rows = [
        thread('ordinary', { disabled, archivedAt }),
        Object.assign(thread('null-coordination', { disabled, archivedAt }), { coordination: null }) as unknown as Thread,
        thread('former-lead', { disabled, archivedAt, coordination: { rootId: 'successor', children: 2, paused: false, retired: true } }),
        thread('retired-member', { disabled, archivedAt, coordination: { rootId: 'lead', children: 2, paused: false, retired: true } }),
      ];
      for (const row of rows) {
        assert.equal(toggles(f.menu(row)).length, 0);
        assert.deepEqual(ids(f.menu(row)), expected);
      }
    }
  }
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.changed, []);
  assert.deepEqual(f.errors, []);
});

// A lead is identified by its actual root ID, even without members or with saved-only settings.
test('collaboration leads never offer disable or enable while retaining all other list actions', () => {
  const f = fixture({ onNewBeside: noop, autotitle: true, board: true });
  const expected = ids(f.menu(thread('ordinary')));
  for (const disabled of [false, true]) {
    for (const children of [0, 2]) {
      for (const enabled of [undefined, false, true]) {
        for (const paused of [false, true]) {
          const lead = thread('lead', { disabled, coordination: { rootId: 'lead', children, paused, enabled } });
          assert.equal(toggles(f.menu(lead)).length, 0);
          assert.deepEqual(ids(f.menu(lead)), expected);
        }
      }
    }
  }
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.changed, []);
  assert.deepEqual(f.errors, []);
});

// Missing or non-boolean daemon metadata cannot expose a toggle, even with an old nested policy flag.
test('sidebar collaboration toggle is hidden unless the thread field is boolean', () => {
  const f = fixture();
  const legacy = Object.assign(thread('legacy'), { coordination: { rootId: 'root', children: 0, paused: false, disabled: true } });
  assert.equal(toggles(f.menu(legacy)).length, 0);
  for (const disabled of [undefined, null, 0, 'false']) {
    assert.equal(toggles(f.menu(Object.assign(thread('legacy', { coordination: { rootId: 'lead', children: 0, paused: false } }), { disabled }) as unknown as Thread)).length, 0);
  }
  assert.deepEqual(f.requests, []);
});

// The new entry belongs only to the list menu; page and section menus keep their existing actions.
test('collaboration toggle appears exactly once in list menus and never in page or section menus', () => {
  const f = fixture();
  for (const disabled of [false, true]) {
    const row = thread('member', { disabled, coordination: { rootId: 'lead', children: 0, paused: false } });
    assert.equal(toggles(f.menu(row)).length, 1);
    assert.equal(toggles(f.menu(row, 'page')).length, 0);
    assert.equal(toggles(f.menu(row, 'section')).length, 0);
  }
});

// The archive separator and all existing action IDs keep their order, including optional and restore items.
test('sidebar collaboration toggle preserves existing actions and sits before the archive separator', () => {
  const f = fixture({ onNewBeside: noop, autotitle: true, board: true });
  const expected = ['new-beside', 'pin', 'unread', 'rename', 'copy-link', 'autotitle', 'board', 'section', 'todo', 'separator', 'archive', 'delete'];
  assert.deepEqual(ids(f.menu(thread('legacy'))), expected);
  for (const archivedAt of [null, '2026-01-03T00:00:00Z']) {
    for (const disabled of [false, true]) {
      assert.deepEqual(ids(f.menu(thread('member', { disabled, archivedAt, coordination: { rootId: 'lead', children: 0, paused: false } }))), [
        ...expected.slice(0, 9), disabled ? 'enable' : 'disable', 'separator', archivedAt ? 'restore' : 'archive', 'delete',
      ]);
    }
  }
});

// A refused save reports the original error and never emits a changed thread or a fake new toggle state.
test('failed collaboration toggle reports onError without changing the row', async () => {
  for (const disabled of [false, true]) {
    const f = fixture();
    const error = new Error('save refused');
    const row = thread('member', { disabled, coordination: { rootId: 'lead', children: 0, paused: false } });
    f.fail(error);
    await select(toggles(f.menu(row))[0]);
    assert.deepEqual(f.requests, [{ id: row.id, updates: { disabled: !disabled } }]);
    assert.deepEqual(f.errors, [error]);
    assert.deepEqual(f.changed, []);
    assert.equal(row.disabled, disabled);
    assert.equal(toggles(f.menu(row))[0].id, disabled ? 'enable' : 'disable');
    assert.deepEqual(f.busy, []);
    assert.deepEqual(f.archived, []);
  }
});

// All three locales use action labels and the existing pause/play icons rather than an input lock.
test('sidebar collaboration toggle uses translated disable and enable labels with pause and play icons', () => {
  const originalLocale = i18n.locale();
  try {
    for (const [locale, disable, enable] of [['zh', '禁用', '启用'], ['en', 'Disable', 'Enable'], ['ja', '無効にする', '有効にする']] as const) {
      i18n.setLocale(locale);
      const f = fixture();
      const [disableItem] = toggles(f.menu(thread('member', { disabled: false, coordination: { rootId: 'lead', children: 0, paused: false } })));
      const [enableItem] = toggles(f.menu(thread('member', { disabled: true, coordination: { rootId: 'lead', children: 0, paused: false } })));
      assert.equal(disableItem.label, disable);
      assert.equal(disableItem.icon, icons.IconPause);
      assert.equal(enableItem.label, enable);
      assert.equal(enableItem.icon, icons.IconPlay);
      assert.equal(disableItem.disabled, undefined);
      assert.equal(enableItem.disabled, undefined);
    }
  } finally { i18n.setLocale(originalLocale); }
});
