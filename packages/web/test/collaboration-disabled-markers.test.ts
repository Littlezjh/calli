import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ModuleKind, JsxEmit, transpileModule } from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import type { Api, Thread } from '../src/api';
import type { Sidebar } from '../src/components/Sidebar';
import type { AssistantHome } from '../src/components/AssistantPanel';
import * as sidebar from '../src/sidebar';
import * as notices from '../src/notices';
import * as paths from '../src/paths';
import * as sessions from '../src/sessions';
import * as timeline from '../src/timeline';
import * as links from '../src/thread-deep-links';
import * as proactive from '../src/proactive';
import * as desk from '../src/desk';
import * as icons from '../src/components/icons';
import * as i18n from '../src/i18n';

const noop = () => undefined;
type Element = React.ReactElement<any>;

// Evaluate only the metadata UI; effects and unrelated child panes stay outside this unit.
function component<T>(name: string, narrow = false, search = ''): T {
  const source = readFileSync(new URL(`../src/components/${name}.tsx`, import.meta.url), 'utf8');
  const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const children = Object.fromEntries(['HostSwitcher', 'Menu', 'PetBustImage', 'HostIcon', 'ActionSheet', 'Composer', 'AgentPicker', 'ModelPicker', 'ThreadView', 'RunControls', 'RunSummary', 'DeskPage', 'PlanView'].map(key => [key, noop]));
  const modules: Record<string, unknown> = {
    react: { ...React, useEffect: noop, useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial === '' ? search : initial, noop], useMemo: (make: () => unknown) => make(), useCallback: (callback: unknown) => callback, useRef: (current: unknown) => ({ current }) },
    'react/jsx-runtime': jsx,
    'react-dom': { createPortal: (node: unknown) => node },
    '../hooks': { useIsNarrow: () => narrow, useMinWidth: () => !narrow, useInTitlebar: () => false, useLongPress: () => () => ({}), useStoredSet: () => [new Set(), noop], useStoredFlag: () => [false, noop] },
    '../api': { ApiError: Error },
    '../i18n': i18n,
    '../sidebar': sidebar,
    '../notices': notices,
    '../paths': paths,
    '../sessions': sessions,
    '../timeline': timeline,
    '../thread-deep-links': links,
    '../proactive': proactive,
    '../desk': desk,
    '../history': {},
    '../videos': {},
    '../extensions/ui': children,
    './icons': icons,
    '../assets/calli.svg': 'calli.svg',
  };
  const module = { exports: {} };
  runInNewContext(code, {
    module, exports: module.exports,
    require: (id: string) => {
      if (id in modules) return modules[id];
      if (/^\.\/[A-Z]/.test(id)) return children;
      throw new Error(`Unexpected UI dependency: ${id}`);
    },
  }, { filename: `${name}.tsx` });
  return module.exports as T;
}

function thread(id: string, extra: Partial<Thread> & { disabled?: boolean } = {}): Thread {
  return {
    id, title: id, agent: 'writer', cwd: '/workspace', cwdReal: '/workspace', status: 'idle', preview: null,
    agentSessionId: null, pinned: false, permissionMode: 'auto_edit', model: null, effort: null, archivedAt: null,
    sectionId: null, forkedFrom: null, unread: false, terminalActivity: false, waiting: false, queued: [], resumeCommand: null,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', ...extra,
  };
}
// Legacy fields stay in regression payloads after they leave the live API type.
const coordination = (rootId: string, extra: Partial<NonNullable<Thread['coordination']>> & { hasDisabledObjects?: boolean; disabled?: boolean } = {}) => ({ rootId, children: 0, paused: false, ...extra });

function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  return React.isValidElement<any>(node) ? [node, ...elements(node.props.children)] : [];
}
const hasClass = (element: Element, name: string) => String(element.props.className ?? '').split(' ').includes(name);
const find = (node: React.ReactNode, name: string) => {
  const element = elements(node).find(item => hasClass(item, name));
  assert.ok(element, `Missing ${name}`);
  return element;
};
const markers = (node: React.ReactNode) => elements(node).filter(item => hasClass(item, 'collaboration-disabled-marker'));
const text = (node: React.ReactNode): string => Array.isArray(node) ? node.map(text).join('') : React.isValidElement<any>(node) ? text(node.props.children) : typeof node === 'string' || typeof node === 'number' ? String(node) : '';

function noMarkers(node: React.ReactNode) {
  assert.equal(markers(node).length, 0, 'retired collaboration markers must not return');
  assert.equal(elements(node).some(item => item.type === icons.IconPause), false, 'disabled state has no list icon');
}

// A seeded search reveals handover history without mounting effects or changing production code.
function sidebarTree(threads: Thread[], extra: Partial<React.ComponentProps<typeof Sidebar>> = {}, search = '') {
  const { Sidebar: render } = component<{ Sidebar: typeof Sidebar }>('Sidebar', false, search);
  return render({ threads, sections: [], agents: [], selectedId: null, onSelect: noop, onNew: noop, onNewIn: noop, onThreadMenu: noop, onSectionMenu: noop, onNewSection: noop, onOpenSettings: noop, ...extra });
}
function homeTree(threads: Thread[], extra: Partial<React.ComponentProps<typeof AssistantHome>> = {}, narrow = false) {
  const { AssistantHome: render } = component<{ AssistantHome: typeof AssistantHome }>('AssistantPanel', narrow);
  return render({ api: { demo: true } as Api, todos: [], loading: false, error: '', threads, threadsKnown: true, agents: [], personal: null, personalError: '', refreshKey: 0, onReload: noop, onPersonalChange: noop, onPersonalRetry: noop, onOpenThread: noop, onOpenPlans: noop, onConfigure: noop, path: 'sessions', onPathChange: noop, focusSignal: 0, ...extra });
}

// Retiring a saved root's policy marker preserves its running dot and history entry.
test('sidebar ignores legacy root flags without changing running history navigation', () => {
  const root = thread('root', { status: 'running', coordination: coordination('root', { enabled: false, hasDisabledObjects: true }) });
  const opened: string[] = [];
  const tree = sidebarTree([root], { onSelect: id => opened.push(id) });
  const button = find(tree, 'thread-item');
  noMarkers(tree);
  assert.equal(text(find(button, 'thread-title')), root.title);
  assert.ok(elements(button).some(item => hasClass(item, 'dot') && hasClass(item, 'running')));
  assert.equal(elements(tree).some(item => hasClass(item, 'handover-toggle')), false);
  assert.equal(button.props.disabled, undefined);
  button.props.onClick();
  assert.deepEqual(opened, ['root']);
});

// Stale member flags cannot hide approvals, running dots, team order or history.
test('sidebar ignores legacy member flags while preserving real attention state', () => {
  const root = thread('root', { coordination: coordination('root', { children: 3, hasDisabledObjects: true }) });
  const quiet = thread('quiet', { coordination: coordination('root') });
  const running = thread('running', { status: 'running', coordination: coordination('root', { disabled: true }) });
  const approval = thread('approval', { status: 'running', waiting: true, coordination: coordination('root', { disabled: true }) });
  const opened: string[] = [];
  const tree = sidebarTree([root], { members: new Map([['root', [quiet, running, approval]]]), onSelect: id => opened.push(id) });
  const rows = elements(tree).filter(item => hasClass(item, 'handover-member'));
  noMarkers(tree);
  assert.deepEqual(rows.map(row => text(find(row, 'handover-member-name'))), ['approval', 'running', 'quiet']);
  assert.ok(find(tree, 'handover-toggle').props['aria-label'].includes(i18n.t('sidebar.agents', 3)));
  for (const [index, state] of ['waiting', 'running'].entries()) {
    assert.ok(elements(rows[index]).some(item => hasClass(item, 'dot') && hasClass(item, state)));
    assert.equal(rows[index].props.disabled, undefined);
    rows[index].props.onClick();
  }
  assert.ok(elements(rows[2]).some(item => hasClass(item, 'dot') && hasClass(item, 'idle')));
  assert.deepEqual(opened, ['approval', 'running']);
});

// Remembered remote history stays reachable with its offline dot, not a policy marker.
test('merged sidebar ignores legacy root flags and preserves offline navigation', () => {
  const root = thread('remote-root', { coordination: coordination('remote-root', { enabled: false, hasDisabledObjects: true }) });
  const opened: unknown[] = [];
  const tree = sidebarTree([], {
    merged: [{ hostId: 'remote', label: 'Remote', state: 'offline', at: root.updatedAt, threads: [root] }],
    onOpenElsewhere: (host, id) => opened.push([host, id]),
  });
  const button = find(tree, 'thread-item');
  noMarkers(tree);
  assert.equal(text(find(button, 'thread-title')), root.title);
  assert.ok(button.props.title.includes(i18n.t('sidebar.merged.openOn', 'Remote')));
  assert.ok(elements(button).some(item => hasClass(item, 'dot') && hasClass(item, 'offline')));
  button.props.onClick();
  assert.deepEqual(opened, [['remote', 'remote-root']]);
});

// Plain, legacy-enabled and exited threads all use ordinary list state; the toggle belongs to the menu.
test('sidebar keeps list order and runtime dots without any disabled state marker', () => {
  const old = thread('old', { status: 'running' });
  const enabled = thread('enabled', { coordination: coordination('enabled', { enabled: true, hasDisabledObjects: false, disabled: false }) });
  const exited = thread('exited', { disabled: true, status: 'running' });
  const tree = sidebarTree([old, enabled, exited]);
  noMarkers(tree);
  const rows = elements(tree).filter(item => hasClass(item, 'thread-item'));
  assert.deepEqual(rows.map(row => text(find(row, 'thread-title'))), ['old', 'enabled', 'exited']);
  assert.equal(elements(tree).filter(item => hasClass(item, 'dot') && hasClass(item, 'running')).length, 2);
});

// The closed Sessions entry ignores old aggregate flags and does not preload history.
test('assistant sessions entry stays unmarked without preloading history', () => {
  const accesses: string[] = [];
  const api = new Proxy({ demo: true }, { get(target, key) { if (key === 'demo') return target.demo; accesses.push(String(key)); throw new Error('No API reads during metadata render'); } }) as Api;
  const root = thread('root', { coordination: coordination('root', { hasDisabledObjects: true, enabled: false }) });
  const opened: string[] = [];
  const tree = homeTree([root], { api, path: '', onPathChange: path => opened.push(path) });
  const entry = elements(tree).find(item => hasClass(item, 'chat-entry') && text(item).includes(i18n.t('desk.entrySessions')))!;
  noMarkers(tree);
  assert.equal(entry.props.title, i18n.t('desk.entrySessions'));
  entry.props.onClick();
  assert.deepEqual(opened, ['sessions']);
  assert.equal(elements(tree).some(item => hasClass(item, 'chat-sessions')), false);
  assert.deepEqual(accesses, []);
});

// Retiring row markers keeps server order, running statistics, unread text and existing history.
test('assistant drawer ignores legacy root and member flags without changing history or counts', () => {
  const root = thread('root', { coordination: coordination('root', { enabled: false, hasDisabledObjects: true }) });
  const member = thread('member', { status: 'running', unread: true, preview: 'Existing history', coordination: coordination('root', { disabled: true }) });
  const idle = thread('idle');
  const archived = thread('archived', { archivedAt: '2026-01-03', coordination: coordination('archived', { hasDisabledObjects: true }) });
  const opened: string[] = [];
  const tree = homeTree([idle, member, root, archived], { onOpenThread: id => opened.push(id) });
  const rows = elements(find(tree, 'chat-sessions')).filter(item => item.type === 'button');
  assert.deepEqual(rows.map(row => text(find(row, 'chat-session-title'))), ['idle', 'member', 'root']);
  noMarkers(tree);
  assert.equal(text(find(rows[1], 'run')), i18n.t('status.running'));
  assert.ok(text(find(rows[1], 'chat-session-meta')).includes(i18n.t('desk.sessionUnread')));
  assert.equal(text(find(rows[1], 'chat-session-line')), 'Existing history');
  assert.ok(text(find(tree, 'chat-strip')).includes(i18n.t('desk.stripRunning', 1)));
  for (const row of rows) {
    assert.equal(row.props.title, undefined, 'no retired policy tooltip');
    assert.equal(row.props.disabled, undefined);
    row.props.onClick();
  }
  assert.deepEqual(opened, ['idle', 'member', 'root']);
});

// A member without its root remains readable; neither old flags nor the new menu-only state add list markers.
test('assistant entry ignores orphan member flags and keeps the archive filter', () => {
  const member = thread('member', { coordination: coordination('missing-root', { disabled: true }) });
  const active = homeTree([member]);
  noMarkers(active);
  assert.equal(text(find(active, 'chat-session-title')), member.title);
  noMarkers(homeTree([{ ...member, coordination: coordination('missing-root', { disabled: false }) }, thread('old')]));
  noMarkers(homeTree([thread('exited', { disabled: true, status: 'running' })]));
  const archived = homeTree([{ ...member, archivedAt: '2026-01-03' }]);
  noMarkers(archived);
  assert.equal(text(find(archived, 'chat-drawer-empty')), i18n.t('desk.sessionsEmpty'));
});

// Searching expands the handover chain; old policy flags must not hide individual histories or their true dots.
test('sidebar retains handover history order, roles and exact menu targets without legacy markers', () => {
  const original = thread('original', { title: 'Task', status: 'error', unread: true, coordination: coordination('original', { disabled: true }) });
  const successor = thread('successor', {
    title: 'Task（接手）', status: 'running', waiting: true, createdAt: '2026-01-02T00:00:00Z',
    handover: { sourceId: original.id, title: original.title, agent: original.agent },
    coordination: coordination('successor', { hasDisabledObjects: true }),
  });
  const opened: string[] = [], menus: string[] = [];
  const tree = sidebarTree([successor, original], { onSelect: id => opened.push(id), onThreadMenu: item => menus.push(item.id) }, 'Task');
  noMarkers(tree);
  const rows = elements(find(tree, 'handover-chain')).filter(item => hasClass(item, 'handover-member'));
  assert.deepEqual(rows.map(row => row.key), ['successor', 'original']);
  assert.deepEqual(rows.map(row => text(find(row, 'handover-member-role'))), [i18n.t('sidebar.successor'), i18n.t('sidebar.original')]);
  assert.equal(find(tree, 'handover-toggle').props['aria-expanded'], true);
  assert.ok(find(tree, 'handover-toggle').props['aria-label'].includes(i18n.t('sidebar.sessions', 2)));
  for (const [index, state] of ['waiting', 'error'].entries()) {
    assert.ok(elements(rows[index]).some(item => hasClass(item, 'dot') && hasClass(item, state)));
    assert.equal(rows[index].props.disabled, undefined);
    rows[index].props.onClick();
    rows[index].props.onContextMenu({ preventDefault: noop, clientX: 10, clientY: 20 });
  }
  assert.deepEqual(opened, ['successor', 'original']);
  assert.deepEqual(menus, ['successor', 'original']);
});

// The same locale and phone coverage now checks ordinary state badges and drawers, not retired policy labels.
test('assistant and sidebar preserve localized desktop and phone state without disabled markers', () => {
  try {
    for (const locale of ['zh', 'en', 'ja'] as const) {
      i18n.setLocale(locale);
      const root = thread('root', { disabled: true, status: 'running', coordination: coordination('root', { hasDisabledObjects: true, enabled: false }) });
      const failed = thread('failed', { status: 'error', coordination: coordination('root', { disabled: true }) });
      for (const narrow of [false, true]) {
        const tree = homeTree([root, failed], {}, narrow);
        const entry = elements(tree).find(item => hasClass(item, 'chat-entry') && text(item).includes(i18n.t('desk.entrySessions')))!;
        noMarkers(tree);
        assert.equal(entry.props.title, i18n.t('desk.entrySessions'));
        assert.equal(entry.props.disabled, undefined);
        assert.equal(find(tree, 'chat-drawer').props['aria-modal'], narrow || undefined);
        assert.equal(text(find(tree, 'run')), i18n.t('status.running'));
        assert.equal(text(find(tree, 'err')), i18n.t('status.error'));
        if (narrow) {
          assert.equal(find(entry, 'chat-badge').props['aria-label'], i18n.t('desk.stripError', 1));
          assert.equal(elements(tree).some(item => hasClass(item, 'chat-strip')), false);
        } else {
          assert.ok(text(find(tree, 'chat-strip')).includes(i18n.t('desk.stripRunning', 1)));
          assert.ok(text(find(tree, 'chat-strip')).includes(i18n.t('desk.stripError', 1)));
          assert.equal(elements(entry).some(item => hasClass(item, 'chat-badge')), false);
        }
        const list = sidebarTree([root], { compact: narrow });
        noMarkers(list);
        assert.equal(hasClass(find(list, 'sidebar-inner'), 'compact'), narrow);
        assert.ok(elements(list).some(item => hasClass(item, 'dot') && hasClass(item, 'running')));
      }
    }
  } finally { i18n.setLocale('zh'); }
});

function menuKey(element: Element, key: string, shiftKey = false) {
  const event = {
    key, shiftKey,
    currentTarget: { getBoundingClientRect: () => ({ left: 11, bottom: 22 }) },
    prevented: false,
    preventDefault() { this.prevented = true; },
  };
  assert.equal(typeof element.props.onKeyDown, 'function', 'a focused session must have a keyboard menu entry');
  element.props.onKeyDown(event);
  return event;
}

// Touch layouts hide the more button; both menu keys use the focused row's exact record without selecting it.
test('sidebar keyboard menus preserve ordinary and root records on desktop and phone', () => {
  for (const compact of [false, true]) {
    const ordinary = thread('ordinary', { disabled: false });
    const root = thread('root', { disabled: true, coordination: coordination('root') });
    const menus: Array<{ item: Thread; x: number; y: number }> = [], opened: string[] = [];
    const tree = sidebarTree([ordinary, root], {
      compact, onSelect: id => opened.push(id),
      onThreadMenu: (item, x, y) => menus.push({ item, x, y }),
    });
    for (const item of [ordinary, root]) {
      const row = elements(tree).find(element => hasClass(element, 'thread-row') && element.key === item.id)!;
      assert.equal(find(row, 'thread-item').type, 'button');
      for (const [key, shift] of [['F10', true], ['ContextMenu', false]] as const) {
        assert.equal(menuKey(row, key, shift).prevented, true);
        assert.equal(menus.at(-1)?.item, item);
        assert.deepEqual([menus.at(-1)?.x, menus.at(-1)?.y], [11, 26]);
      }
    }
    assert.equal(menus.length, 4);
    assert.deepEqual(opened, []);
  }
});

// Team shortcuts act on each member, never its lead or another session of the same instance.
test('sidebar keyboard menus preserve exact team member identity', () => {
  const root = thread('root', { coordination: coordination('root', { children: 2 }) });
  const active = thread('active', { status: 'running', disabled: false, coordination: coordination('root') });
  const exited = thread('exited', { disabled: true, coordination: coordination('root') });
  const menus: Thread[] = [], opened: string[] = [];
  const tree = sidebarTree([root], {
    compact: true, members: new Map([['root', [active, exited]]]),
    onSelect: id => opened.push(id), onThreadMenu: item => menus.push(item),
  });
  for (const item of [active, exited]) {
    const row = elements(tree).find(element => hasClass(element, 'handover-member') && element.key === item.id)!;
    assert.equal(row.type, 'button');
    for (const [key, shift] of [['F10', true], ['ContextMenu', false]] as const) {
      assert.equal(menuKey(row, key, shift).prevented, true);
      assert.equal(menus.at(-1), item);
    }
  }
  assert.equal(menus.length, 4);
  assert.deepEqual(opened, []);
});

// A chain's card targets its latest session; expanded history targets the particular predecessor button.
test('sidebar keyboard menus preserve latest and expanded predecessor identity', () => {
  const original = thread('original', { title: 'Task', disabled: true });
  const latest = thread('latest', {
    title: 'Task（接手）', disabled: false, createdAt: '2026-01-02T00:00:00Z',
    handover: { sourceId: original.id, title: original.title, agent: original.agent },
  });
  const menus: Thread[] = [], opened: string[] = [];
  const tree = sidebarTree([latest, original], {
    compact: true, onSelect: id => opened.push(id), onThreadMenu: item => menus.push(item),
  }, 'Task');
  const card = find(tree, 'thread-row');
  const history = elements(find(tree, 'handover-chain')).filter(element => hasClass(element, 'handover-member'));
  assert.deepEqual(history.map(element => element.key), ['latest', 'original']);
  for (const [row, item] of [[card, latest], [history[0], latest], [history[1], original]] as const) {
    for (const [key, shift] of [['F10', true], ['ContextMenu', false]] as const) {
      assert.equal(menuKey(row, key, shift).prevented, true);
      assert.equal(menus.at(-1), item);
    }
  }
  assert.equal(menus.length, 6);
  assert.deepEqual(opened, []);
});

// Normal activation and navigation keys keep their existing defaults on every session row shape.
test('sidebar keyboard menus ignore Enter Space navigation and unmodified F10', () => {
  const original = thread('original', { title: 'Task', coordination: coordination('original', { children: 1 }) });
  const latest = thread('latest', { title: 'Task（接手）', createdAt: '2026-01-02T00:00:00Z', handover: { sourceId: original.id, title: original.title, agent: original.agent } });
  const member = thread('member', { title: 'Task member', status: 'running', coordination: coordination('original') });
  const menus: Thread[] = [], opened: string[] = [];
  const tree = sidebarTree([latest, original], {
    compact: true, members: new Map([['original', [member]]]),
    onSelect: id => opened.push(id), onThreadMenu: item => menus.push(item),
  }, 'Task');
  const rows = elements(tree).filter(element => hasClass(element, 'thread-row') || hasClass(element, 'handover-member'));
  assert.equal(rows.length, 4);
  for (const row of rows) {
    for (const [key, shift] of [['F10', false], ['Enter', false], ['Enter', true], [' ', false], ['ArrowDown', false], ['Escape', false]] as const) {
      assert.equal(menuKey(row, key, shift).prevented, false);
    }
  }
  assert.deepEqual(menus, []);
  assert.deepEqual(opened, []);
  find(tree, 'thread-item').props.onClick();
  assert.deepEqual(opened, ['latest']);
});

// Identical ids on separate machines retain the existing callback scope and original object identity.
test('sidebar keyboard menus retain machine-scoped callbacks and merged remote records', () => {
  const local = thread('same-id', { disabled: false });
  const remote = thread('same-id', { disabled: true });
  const menus: Array<{ hostId: string | null; item: Thread }> = [];
  for (const [hostId, item] of [[null, local], ['remote', remote]] as const) {
    const tree = sidebarTree([item], { compact: true, hostId, onThreadMenu: record => menus.push({ hostId, item: record }) });
    menuKey(find(tree, 'thread-row'), 'F10', true);
    assert.equal(menus.at(-1)?.hostId, hostId);
    assert.equal(menus.at(-1)?.item, item);
  }
  const merged = sidebarTree([], {
    compact: true,
    merged: [{ hostId: 'remote', label: 'Remote', state: 'offline', at: remote.updatedAt, threads: [remote] }],
    onOpenElsewhere: noop,
    onThreadMenu: item => menus.push({ hostId: 'merged', item }),
  });
  assert.equal(menuKey(find(merged, 'thread-row'), 'ContextMenu').prevented, true);
  assert.equal(menus.at(-1)?.hostId, 'merged');
  assert.equal(menus.at(-1)?.item, remote);
  assert.equal(menus.length, 3);
});
