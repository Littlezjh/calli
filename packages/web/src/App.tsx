import type { WorkMode } from './api';
import { HandoverTrail } from './components/HandoverTrail';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Api,
  ApiError,
  AuthError,
  MAX_QUEUED,
  type AgentInfo,
  type ModelOption,
  type Section,
  type SlashCommand,
  type Thread,
  type Todo,
  type Schedule,
  type WorkdirsConfig,
} from './api';
import type { HubAction } from './commands';
import { buildProjectOptions } from './projects';
import { useAppearance, useIsCompact, useListSwipe } from './hooks';
import { useHosts } from './hosts';
import type { PreparedImage } from './images';
import { restoreVideos, type PreparedVideo } from './videos';
import { attentionCount, pageTitle, threadNotices } from './notices';
import { folderName } from './paths';
import { PERMISSION_LABELS, PERMISSION_ORDER, permissionHint, startingPermission } from './permissions';
import { buildTimeline, toMarkdown, turnPreviews, type StoredEvent } from './timeline';
import { newerBuildAvailable } from './version';
import { AppearancePanel } from './components/AppearancePanel';
import { ArchivePanel } from './components/ArchivePanel';
import { Composer, prefillComposerDraft, type DraftNote } from './components/Composer';
import { CollaborationMenu } from './components/CollaborationMenu';
import { DirectoryPicker } from './components/DirectoryPicker';
import { Dialog } from './components/Dialog';
import { HostDown, HostsPanel, MachinePicker } from './components/Hosts';
import { ImportPanel } from './components/ImportPanel';
import { Menu } from './components/Menu';
import { StatusPanel } from './components/StatusPanel';
import { TerminalPanel } from './components/TerminalPanel';
import { FilesPanel, type FilesTarget } from './components/FilesPanel';
import { PreviewPanel } from './components/PreviewPanel';
import { fileRef } from './files';
import { AddAgentDialog } from './components/AddAgentDialog';
import { ObservabilityPanel } from './components/ObservabilityPanel';
import { QuotaBoard } from './components/QuotaBoard';
import { SelectionMenu } from './components/SelectionMenu';
import { AgentPanel, TeamCard } from './components/AgentPanel';
import type { AgentMention, Coordination, MemberDefault, SearchHit } from './api';
import { Popover as CoordinationPopover } from './components/Popover';
import { SideChat } from './components/SideChat';
import { McpPage } from './components/McpPage';
import { SkillsPage } from './components/SkillsPage';
import { SchedulesPage } from './components/SchedulesPage';
import { TodosPage } from './components/TodosPage';
import { ActivityPage } from './components/ActivityPage';
import { AgentPicker, type DiscoveredAccount, type DiscoveredAgent, effortsForModel, imagesBlocked, imagesNote, modelName, speedsForModel, ModelPicker, PermissionPicker, UsageMeter, WorkspacePicker } from './components/Pickers';
import { Sidebar, SIDEBAR_SHORTCUT } from './components/Sidebar';
import { forkBlocked, useThreadActions } from './components/ThreadActions';
import { ThreadView } from './components/ThreadView';
import { TurnRuler } from './components/TurnRuler';
import { NewProjectDialog, ProjectPicker, RootsDialog } from './components/Projects';
import { NoteMarks, type NoteMark } from './components/NoteMarks';
import { Toast, type ToastState } from './components/Toast';
import { ConnectDialog, DemoBar } from './components/ConnectDialog';
import { DemoApi, DemoError } from './demo/DemoApi';
import { IconCheck, AgentMark, IconAgents, IconArchive, IconArrowDown, IconBack, IconClose, IconEdit, IconFiles, IconFolder, IconGauge, IconGlobe, IconImport, IconList, IconMenu, IconMore, IconPalette, IconPlus, IconServer, IconSidebar, IconSignIn, IconSignOut, IconSparkle, IconTerminal } from './components/icons';

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** How long streamed events are collected before the view updates. Keeps long, fast streams smooth. */
const FLUSH_MS = 40;

/** How close to the end of the thread still counts as being at the bottom. */
const NEAR_BOTTOM_PX = 160;
/** Momentum keeps a list scrolling for a while after the hand that flicked it has lifted. */
const GESTURE_GRACE_MS = 1500;

/** How often, at most, the page asks whether a newer build is being served. */
const UPDATE_CHECK_MS = 30_000;

const isNearBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;

/** The plan page's address. Threads have none: the main area showing a thread is the plain URL. */
const TODOS_HASH = '#/todos';
const SKILLS_HASH = '#/skills';
const MCP_HASH = '#/mcp';
const SCHEDULES_HASH = '#/schedules';
const ACTIVITY_HASH = '#/activity';

/** Whether the thread list is put away on a wide screen. */
const SIDEBAR_HIDDEN_KEY = 'rah.sidebar.hidden';

/** What members of each instance start with, remembered on this device for the next team. */
const MEMBER_DEFAULTS_KEY = 'rah.coord.defaults';
function savedMemberDefaults(key: string): Record<string, MemberDefault> {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch {
    return {};
  }
}

/** The model and thinking effort for one instance's members: a quiet mark until something is chosen. */
function MemberModel({ agent, models, value, permission, onNeed, onChange, onPermission }: {
  agent: AgentInfo; models: ModelOption[]; value: MemberDefault; onNeed: (agent: string) => void; onChange: (value: MemberDefault) => void;
  /** The level in force, and how to change it; left out where the agent has no levels. */
  permission?: string; onPermission?: (mode: string) => void;
}) {
  useEffect(() => { onNeed(agent.id); }, [agent.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const efforts = agent.capabilities.effortLevels ?? [];
  return (<>
    {permission && onPermission && <PermissionPicker quietFor={agent.label} modes={agent.capabilities.permissionModes} value={permission} canAsk={agent.capabilities.approvals ?? true} onChange={onPermission} />}
    <ModelPicker
      quietFor={agent.label}
      models={models}
      model={value.model}
      efforts={efforts}
      effort={value.effort}
      // An effort the newly picked model does not take goes back to the default with it.
      onModel={(model) => onChange({ ...value, model, effort: value.effort && effortsForModel(models, model, efforts).includes(value.effort) ? value.effort : null })}
      onEffort={(effort) => onChange({ ...value, effort })}
    />
  </>);
}

interface AppProps {
  /** The hub's access token; empty shows the demo workspace, which talks to no daemon. */
  token: string;
  /** Connects (a token the hub accepted) or disconnects (empty, with why when it was not the user's doing). */
  onToken: (token: string, reason?: string) => void;
  /** Opens the connect dialog at once, saying why. */
  connect?: { reason?: string };
  /** The machine on screen: one of the hub's other machines, or null for the hub's own. */
  hostId?: string | null;
  /** Switches machines. The app starts over on the new one, with what the switch was made from still open. */
  onHost?: (id: string | null, start?: AppStart) => void;
  start?: AppStart;
}

/** What is open when the app starts over on another machine: the phone's thread list, or the machines panel. */
export type AppStart = 'list' | 'machines';

export function App({ token, onToken, connect, hostId = null, onHost, start }: AppProps) {
  // Asking for the token, and why: what was being done, or why the old one stopped working.
  const [connectAsk, setConnectAsk] = useState<{ reason?: string } | null>(connect ?? null);
  // Looking at another machine, every call is answered by its daemon, through the hub.
  const { hosts, loaded: hostsLoaded, reload: reloadHosts } = useHosts(token);
  const host = hostId ? hosts.find((h) => h.id === hostId) : undefined;
  // Until the hub has said how the machine is, it is taken to be up: asking it is how the page finds out.
  const hostUp = !hostId || !hostsLoaded || host?.status === 'online';
  // A machine that comes back gets a new client, so everything is read from it again.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const api = useMemo<Api>(() => (token ? new Api(token, '', hostId) : new DemoApi()), [token, hostId, hostUp]);
  const demo = api.demo;
  const [hostsOpen, setHostsOpen] = useState(start === 'machines');
  // A machine that was removed (here or on another device) has nothing to show: back to the hub's own.
  useEffect(() => {
    if (hostId && hostsLoaded && !host) onHost?.(null, hostsOpen ? 'machines' : undefined);
  }, [hostId, hostsLoaded, host, onHost, hostsOpen]);

  const [agents, setAgents] = useState<AgentInfo[]>([]);
  /** CLIs on PATH that look like extra agents, offered in the picker. */
  const [discovered, setDiscovered] = useState<DiscoveredAgent[]>([]);
  /** Accounts of multi-account agents already signed in here, offered in the picker. */
  const [accounts, setAccounts] = useState<DiscoveredAccount[]>([]);
  const [workdirs, setWorkdirs] = useState<string[]>([]);
  // Each project root and whether it was added from the page; and whether threads can be in no project.
  const [roots, setRoots] = useState<Array<{ path: string; removable: boolean }>>([]);
  const [scratchAvailable, setScratchAvailable] = useState(false);
  // A new thread in no project: the hub gives it a scratch folder.
  const [draftScratch, setDraftScratch] = useState(false);
  const [projectDialog, setProjectDialog] = useState<'new' | 'roots' | null>(null);
  const applyWorkdirs = useCallback((c: WorkdirsConfig) => {
    setWorkdirs(c.workdirs);
    setRoots(c.roots ?? c.workdirs.map((path) => ({ path, removable: false })));
    setScratchAvailable(c.scratch === true);
  }, []);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  /** What the main area shows: a thread (or the blank one a new thread starts from), the plan page, the scheduled-task page, the overview page, or the skills page. */
  // Those pages have addresses of their own, so a reload or a bookmark lands back on them.
  const [view, setView] = useState<'thread' | 'todos' | 'schedules' | 'activity' | 'skills' | 'mcp'>(() =>
    window.location.hash === TODOS_HASH
      ? 'todos'
      : window.location.hash === SCHEDULES_HASH
        ? 'schedules'
        : window.location.hash === ACTIVITY_HASH
          ? 'activity'
          : window.location.hash === SKILLS_HASH && token
            ? 'skills'
            : window.location.hash === MCP_HASH && token
              ? 'mcp'
              : 'thread',
  );
  /** Bumped by daemon broadcasts, so the open plan page reloads. */
  const [todosKey, setTodosKey] = useState(0);
  /** The same, for the open scheduled-task page. */
  const [schedulesKey, setSchedulesKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [coordination, setCoordination] = useState<Coordination | null>(null);
  const memberDefaultsKey = hostId ? `${MEMBER_DEFAULTS_KEY}:${hostId}` : MEMBER_DEFAULTS_KEY;
  const [memberDefaults, setMemberDefaults] = useState(() => savedMemberDefaults(memberDefaultsKey));
  // Members work unattended, so they start with full access unless this device was told otherwise.
  const [memberPermission, setMemberPermission] = useState(() => localStorage.getItem(`${memberDefaultsKey}.permission`) ?? 'full_access');
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [draftCollaboration, setDraftCollaboration] = useState(false);
  const [collaborationDirectories, setCollaborationDirectories] = useState<string[]>([]);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [draftAgent, setDraftAgent] = useState('');
  const [draftCwd, setDraftCwd] = useState('');
  // A new thread may start in a git worktree of its directory; offered only when the directory is in a repository.
  const [draftWorktree, setDraftWorktree] = useState(false);
  const [worktreeOffer, setWorktreeOffer] = useState<{ cwd: string; branch: string | null; changes: number } | null>(null);
  const [draftSectionId, setDraftSectionId] = useState<string | null>(null);
  const [draftWorkMode, setDraftWorkMode] = useState<WorkMode>('execute');
  const [modeBusy, setModeBusy] = useState(false);
  const [draftPermission, setDraftPermission] = useState('auto_edit');
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [draftEffort, setDraftEffort] = useState<string | null>(null);
  const [draftSpeed, setDraftSpeed] = useState<string | null>(null);
  const [modelsByAgent, setModelsByAgent] = useState<Record<string, ModelOption[]>>({});
  const [commandsByKey, setCommandsByKey] = useState<Record<string, SlashCommand[]>>({});
  const [drawer, setDrawer] = useState(start === 'list');
  // On a wide screen the list can be put away for room, like Codex; remembered on this device.
  const [sidebarHidden, setSidebarHidden] = useState(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_HIDDEN_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleSidebar = useCallback(() => {
    setSidebarHidden((hidden) => {
      try {
        window.localStorage.setItem(SIDEBAR_HIDDEN_KEY, hidden ? '0' : '1');
      } catch {
        // Not remembered, still toggled.
      }
      return !hidden;
    });
  }, []);
  // On a phone the thread list is a page of its own; `drawer` slides the conversation off to show it.
  const compact = useIsCompact();
  // ⇧⌘S (Ctrl+Shift+S elsewhere), Codex's key for it. Only where there is a sidebar to put away.
  useEffect(() => {
    if (compact) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'KeyS' && e.shiftKey && (e.metaKey || e.ctrlKey) && !e.altKey) {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [compact, toggleSidebar]);
  const listOpen = drawer && compact;
  useListSwipe(compact, listOpen, setDrawer);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  /** Where the settings menu opened from, while it is open. */
  const [settingsAt, setSettingsAt] = useState<{ x: number; y: number } | null>(null);
  const [appearance, setAppearance, theme] = useAppearance();
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [showDirPicker, setShowDirPicker] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveKey, setArchiveKey] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [termOpen, setTermOpen] = useState(false);
  /** The agent whose plan usage the quota panel shows. */
  /** The quota dashboard, over every agent that can report usage. */
  const [quotaOpen, setQuotaOpen] = useState(false);
  const [observability, setObservability] = useState<'usage' | 'diagnostics' | null>(null);
  /** Other agent CLIs found on this host, added from the settings menu — not the picker. */
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  // Counters that open the composer's pickers from elsewhere (the slash menu).
  const [permissionSignal, setPermissionSignal] = useState(0);
  const [modelSignal, setModelSignal] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  // The thread has turns older than the ones loaded; they are fetched a page at a time.
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // The first page of the open thread is still on its way from the daemon.
  const [eventsLoading, setEventsLoading] = useState(false);
  // Text handed back to the composer: messages that were waiting when the user pressed stop.
  const [restore, setRestore] = useState<{ text: string; nonce: number; mentions?: AgentMention[] } | null>(null);
  // Text quoted out of a message by selecting it.
  const [noteSignal, setNoteSignal] = useState<(DraftNote & { nonce: number }) | null>(null);
  // Where each noted passage stands in the conversation, for as long as its note waits in the box.
  const noteRanges = useRef(new Map<string, Range>());
  const [noteMarks, setNoteMarks] = useState<NoteMark[]>([]);
  const onNotesChange = useCallback((notes: DraftNote[]) => {
    const ranges = noteRanges.current;
    for (const id of [...ranges.keys()]) if (!notes.some((n) => n.id === id)) ranges.delete(id);
    setNoteMarks(notes.flatMap((n, i) => {
      const range = ranges.get(n.id);
      return range ? [{ id: n.id, n: i + 1, range }] : [];
    }));
  }, []);
  // The passage a side chat was opened for, if one is open.
  const [sideAsk, setSideAsk] = useState<{ text: string; nonce: number } | null>(null);
  // A message waiting for the user to confirm sending into a session the terminal also used.
  const [pendingSend, setPendingSend] = useState<{ text: string; images: PreparedImage[]; videos?: PreparedVideo[]; mentions?: AgentMention[]; resolve: () => void; reject: (e: unknown) => void } | null>(null);
  const [pageHidden, setPageHidden] = useState(() => document.hidden);
  const baseTitle = useRef(document.title);
  const seenThreads = useRef<Thread[] | null>(null);

  const timeline = useMemo(() => buildTimeline(events), [events]);
  const turnPreviewMap = useMemo(() => turnPreviews(timeline.items), [timeline.items]);
  // What the user last sent here, for a box that was reloaded mid-send to learn that its message arrived.
  const lastSent = useMemo(() => {
    for (let i = timeline.items.length - 1; i >= 0; i--) {
      const item = timeline.items[i];
      if (item.kind === 'user' && !item.coordination) return { turnId: item.turnId, text: item.text };
    }
    return null;
  }, [timeline.items]);
  const selected = threads.find((t) => t.id === selectedId) ?? null;
  useEffect(() => {
    let cancelled = false;
    if (!api || !selected?.coordination) { setCoordination(null); return; }
    void api.coordination(selected.id).then(value => { if (!cancelled) setCoordination(value); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [api, selectedId, threads]);
  useEffect(() => { setAgentsOpen(false); setDraftCollaboration(false); setCollaborationDirectories([]); }, [selectedId, hostId]);
  const onTodos = view === 'todos' && !selectedId;
  const onSchedules = view === 'schedules' && !selectedId;
  const onActivity = view === 'activity' && !selectedId;
  const onSkills = view === 'skills' && !selectedId;
  const onMcp = view === 'mcp' && !selectedId;

  // The address follows what the main area shows. Replaced, not pushed: going between the pages and
  // threads is not a trail for the back button to walk.
  useEffect(() => {
    const want = onTodos ? TODOS_HASH : onSchedules ? SCHEDULES_HASH : onActivity ? ACTIVITY_HASH : onSkills ? SKILLS_HASH : onMcp ? MCP_HASH : '';
    if (window.location.hash !== want) {
      window.history.replaceState(window.history.state, '', want || window.location.pathname + window.location.search);
    }
  }, [onTodos, onActivity, onSkills, onSchedules, onMcp]);

  // Whether the directory a new thread would start in is a git repository. Asked once per directory picked.
  useEffect(() => {
    if (!api || !draftCwd || selectedId) return;
    let stale = false;
    api
      .worktreeOptions(draftCwd)
      .then((o) => {
        if (!stale) setWorktreeOffer(o.available ? { cwd: draftCwd, branch: o.branch ?? null, changes: o.changes ?? 0 } : null);
      })
      .catch(() => !stale && setWorktreeOffer(null));
    return () => {
      stale = true;
    };
  }, [api, draftCwd, selectedId]);
  const offer = worktreeOffer?.cwd === draftCwd ? worktreeOffer : null;
  // Projects for a new thread: where threads went lately, newest first, then roots not used yet.
  const projectOptions = useMemo(() => buildProjectOptions(threads, workdirs, draftCwd), [threads, workdirs, draftCwd]);

  // An address typed or followed while the page is open.
  useEffect(() => {
    const onHash = () => {
      if (window.location.hash === TODOS_HASH) {
        setSelectedId(null);
        setView('todos');
        setDrawer(false);
      }
      if (window.location.hash === SCHEDULES_HASH) {
        setSelectedId(null);
        setView('schedules');
        setDrawer(false);
      }
      if (window.location.hash === ACTIVITY_HASH) {
        setSelectedId(null);
        setView('activity');
        setDrawer(false);
      }
      if (window.location.hash === SKILLS_HASH && token) {
        setSelectedId(null);
        setView('skills');
        setDrawer(false);
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Both spellings of the thread's directory; kept stable so the thread view is not re-rendered for nothing.
  const threadRoots = useMemo(() => (selected ? [selected.cwd, selected.cwdReal] : []), [selected?.cwd, selected?.cwdReal]);
  const running = timeline.running || selected?.status === 'running';

  // Members are listed under their lead in the sidebar, not as threads of their own.
  const teamMembers = useMemo(() => {
    const byLead = new Map<string, Thread[]>();
    for (const t of threads) {
      if (t.coordination && t.coordination.rootId !== t.id) byLead.set(t.coordination.rootId, [...(byLead.get(t.coordination.rootId) ?? []), t]);
    }
    return byLead;
  }, [threads]);

  // A takeover under way, from the button on a turn that failed because the plan ran out.
  const [takingOver, setTakingOver] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  // Whether the margin beside the conversation is wide enough to hold the team's card.
  const mainRef = useRef<HTMLElement>(null);
  const [roomy, setRoomy] = useState(false);
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const read = () => {
      const column = parseFloat(getComputedStyle(el).getPropertyValue('--content-w')) || 760;
      setRoomy((el.clientWidth - column) / 2 >= 272);
    };
    read();
    const watch = new ResizeObserver(read);
    watch.observe(el);
    return () => watch.disconnect();
  });
  const [agentsStart, setAgentsStart] = useState<string | null>(null);
  const stickToBottom = useRef(true);
  // The thread on screen, for answers that arrive after the user has moved on.
  const shownThread = useRef<string | null>(null);
  shownThread.current = selectedId;
  // Whether the user has a hand on the scroller, and when they last did.
  const gesture = useRef({ held: false, at: 0 });

  const askToConnect = () => setConnectAsk((cur) => cur ?? {});

  // The app starts over on the demo; a token that stopped working says so in the connect dialog.
  const signOut = (msg?: string) => onToken('', msg);

  const handleError = (e: unknown) => {
    // In the demo, doing something asks to connect; a part it has no data for just stays empty.
    if (e instanceof DemoError) {
      if (e.write) askToConnect();
    } else if (e instanceof AuthError) signOut('token 无效或已过期，请重新输入');
    // A machine that dropped is explained in the main area; the hub is asked at once how it is.
    else if (e instanceof ApiError && e.details.code === 'host_offline') void reloadHosts();
    else setError(message(e));
  };

  const refreshThreads = () => api?.threads().then(setThreads).catch(() => undefined);
  const reloadTodos = useCallback(() => api?.todos().then(setTodos).catch(() => undefined), [api]);
  const reloadSchedules = useCallback(
    () => api?.schedules().then(setSchedules).catch(() => setSchedules([])),
    [api],
  );
  const dismissToast = useCallback(() => setToast(null), []);

  // Initial data once we have a token.
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    (async () => {
      try {
        const [a, c, t, s, td, sc] = await Promise.all([
          api.agents(),
          api.workdirs(),
          api.threads(),
          api.sections(),
          api.todos().catch(() => []),
          api.schedules().catch(() => []),
        ]);
        if (cancelled) return;
        setAgents(a);
        applyWorkdirs(c);
        setThreads(t);
        setSections(s);
        setTodos(td);
        setSchedules(sc);
        setDraftCwd((cur) => cur || c.workdirs[0] || '');
        const first = a.find((x) => x.available);
        setDraftAgent(first?.id ?? '');
        if (first) setDraftPermission(startingPermission(first.capabilities));
        // Cheap enough to do once: PATH scan for other copies of known CLIs.
        api
          .discoverAgents()
          .then(setDiscovered)
          .catch(() => undefined);
        api
          .discoverAccounts()
          .then(setAccounts)
          .catch(() => undefined);
      } catch (e) {
        if (!cancelled) handleError(e);
      }
    })();
    return () => {
      cancelled = true;
    };
    // handleError only touches state setters, so it is stable enough to leave out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  // Thread-list changes, pushed by the daemon. Refresh is debounced.
  useEffect(() => {
    if (!api) return;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        api.threads().then(setThreads).catch(() => undefined);
        // Plan chips show thread states; a bumped key reloads the open page.
        setTodosKey((k) => k + 1);
        // Scheduled runs finish and problems appear the same way.
        api.schedules().then(setSchedules).catch(() => undefined);
        setSchedulesKey((k) => k + 1);
      }, 150);
    };
    (async () => {
      for (let attempt = 0; !ctrl.signal.aborted; attempt++) {
        // Whatever changed while the stream was down was never announced on it. A dropped stream
        // is also how a restarted daemon looks from here, so it is a moment to look for a new build.
        if (attempt > 0) {
          refresh();
          checkForUpdate();
        }
        try {
          await api.stream('/api/stream', refresh, ctrl.signal);
        } catch (e) {
          if (e instanceof AuthError) return signOut('token 无效或已过期，请重新输入');
          // On another machine, a stream that will not open is how its dropping first shows.
          if (api.host && !ctrl.signal.aborted) void reloadHosts();
        }
        await sleep(2000, ctrl.signal);
      }
    })();
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  // A page left open keeps running the build it loaded. When the daemon serves a newer one, say
  // so and offer to reload; asked when the list stream reconnects and when the page comes back
  // to the foreground, at most once in a while.
  const updateAskedAt = useRef(0);
  const checkForUpdate = () => {
    if (Date.now() - updateAskedAt.current < UPDATE_CHECK_MS) return;
    updateAskedAt.current = Date.now();
    void newerBuildAvailable().then((newer) => {
      if (newer) setToast({ message: '有新版本', action: { label: '刷新', run: () => window.location.reload() }, sticky: true });
    });
  };

  // Event log for the selected thread: the newest turns first (a long thread's full log can be
  // tens of thousands of events), then a live stream that resumes from the last seq. Older
  // turns are paged in on demand from the top.
  useEffect(() => {
    setEvents([]);
    setHasOlder(false);
    setLoadingOlder(false);
    setEventsLoading(Boolean(api && selectedId));
    if (!api || !selectedId) return;
    const ctrl = new AbortController();
    const id = selectedId;
    stickToBottom.current = true;
    setAtBottom(true);

    // A fast stream can deliver hundreds of events a second. Collect them briefly and update once,
    // so the timeline is rebuilt at most ~25 times a second instead of once per event.
    let buffer: StoredEvent[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      flushTimer = undefined;
      const batch = buffer;
      buffer = [];
      if (ctrl.signal.aborted || batch.length === 0) return;
      setEvents((prev) => {
        let last = prev.length ? prev[prev.length - 1].seq : 0;
        const fresh = batch.filter((ev) => (ev.seq > last ? ((last = ev.seq), true) : false));
        return fresh.length ? [...prev, ...fresh] : prev;
      });
    };

    (async () => {
      let after = 0;
      try {
        const initial = await api.eventsTail(id);
        if (ctrl.signal.aborted) return;
        setEvents(initial);
        setEventsLoading(false);
        // A thread's log starts at seq 1; a page that starts later has turns before it.
        setHasOlder(initial.length > 0 && initial[0].seq > 1);
        after = initial.at(-1)?.seq ?? 0;
      } catch (e) {
        if (!ctrl.signal.aborted) {
          setEventsLoading(false);
          handleError(e);
        }
        return;
      }
      while (!ctrl.signal.aborted) {
        try {
          await api.stream(
            `/api/threads/${id}/stream?after=${after}`,
            (ev) => {
              after = Math.max(after, ev.seq);
              buffer.push(ev);
              flushTimer ??= setTimeout(flush, FLUSH_MS);
            },
            ctrl.signal,
          );
        } catch (e) {
          if (e instanceof AuthError) return signOut('token 无效或已过期，请重新输入');
        }
        await sleep(1500, ctrl.signal);
      }
    })();
    return () => {
      ctrl.abort();
      clearTimeout(flushTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, selectedId]);

  /** Prepends the page of turns before the loaded ones, keeping the scroll position on the same content. */
  const loadOlder = async () => {
    const id = selectedId;
    const first = events[0]?.seq ?? 0;
    if (!api || !id || loadingOlder || first <= 1) return;
    setLoadingOlder(true);
    try {
      const older = await api.eventsBefore(id, first);
      // The answer is for the thread that asked; another one may be open by now.
      if (shownThread.current !== id) return;
      setHasOlder(older.length > 0 && older[0].seq > 1);
      const el = scrollerRef.current;
      const fromBottom = el ? el.scrollHeight - el.scrollTop : 0;
      setEvents((prev) => (prev[0]?.seq === first ? [...older, ...prev] : prev));
      // New content lands above the viewport; stay on the same row while it inserts.
      requestAnimationFrame(() => {
        if (el && !stickToBottom.current) el.scrollTop = el.scrollHeight - fromBottom;
      });
    } catch (e) {
      handleError(e);
    } finally {
      setLoadingOlder(false);
    }
  };

  // Keep the view pinned to the bottom while the user has not scrolled up.
  useEffect(() => {
    const el = scrollerRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  // Screenshots and slow-rendering blocks grow the thread after the scroll above, which used to
  // leave a reopened thread parked at the top. Watching the thread's height keeps it pinned. The
  // scroller is watched too: a phone keyboard shrinks it and would hide the newest lines.
  useEffect(() => {
    const el = scrollerRef.current;
    const content = el?.querySelector('.thread');
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
      // Growth below an unpinned view moves nothing, so no scroll event reports that the view
      // has fallen behind; the jump button has to learn it here.
      else setAtBottom(isNearBottom(el));
    });
    ro.observe(content);
    ro.observe(el);
    return () => ro.disconnect();
  }, [selectedId]);

  // A phone keyboard does not resize the page: it covers the bottom of it, and the browser pans
  // what is left (the visual viewport) over the page to keep the focused field in sight. So the
  // app is drawn exactly where the visual viewport is: its height, and its offset down the page.
  // Following the height alone is not enough. Safari pans to the field before the app has shrunk,
  // and stays panned: the app, still at the top of the page, shows only its lower part at the top
  // of the screen, with bare page under it down to the keyboard.
  // Pinch zoom moves and shrinks the visual viewport too, and that is not the keyboard.
  //
  // This is the one keyboard mechanism: never add interactive-widget=resizes-content to the
  // viewport meta as well, or where it is honoured the keyboard is taken off twice.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => {
      if (Math.abs(vv.scale - 1) >= 0.01) return;
      const root = document.documentElement.style;
      root.setProperty('--vvh', `${vv.height}px`);
      root.setProperty('--vvt', `${vv.pageTop}px`);
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    // The closing keyboard's last report can be lost: the pan-back can land without a final
    // scroll event, and a keyboard closed while the page was hidden (app switch, lock, another
    // tab) reports nothing at all. The app then stays drawn shrunk and panned, and the edge
    // colour below fills most of the screen. Re-read the viewport when focus leaves a field
    // and when the page comes back, and keep re-reading briefly, past the close animation.
    const timers: number[] = [];
    const settle = () => {
      timers.forEach((t) => clearTimeout(t));
      timers.length = 0;
      for (const ms of [0, 250, 700]) timers.push(window.setTimeout(apply, ms));
    };
    const onVisible = () => { if (!document.hidden) settle(); };
    document.addEventListener('focusout', settle);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', settle);
    window.addEventListener('orientationchange', settle);
    return () => {
      timers.forEach((t) => clearTimeout(t));
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      document.removeEventListener('focusout', settle);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', settle);
      window.removeEventListener('orientationchange', settle);
    };
  }, []);

  // What a phone paints behind its status bar follows the page: the theme colour on older
  // systems, the page background on newer ones. With the list open the top of the screen is the
  // list, so both say the list's colour; otherwise a band of the wrong shade sits above it.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('list-open', listOpen);
    // The keyboard belongs to the conversation; it goes down when the conversation moves aside.
    if (listOpen && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    // Read again whenever the look changes: by then the new palette is on the page.
    const colour = getComputedStyle(root).getPropertyValue(listOpen ? '--sidebar' : '--bg').trim();
    if (colour) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', colour);
  }, [listOpen, theme, appearance.palette]);

  // A scroll hands the position over to the user only when their hand caused it. Scroll events
  // also come from the pin itself, from the keyboard resizing the page and from content changing
  // height, and none of those may unpin the view. A gesture that scrolls nothing here (a sideways
  // swipe over a code block) unpins nothing either. Scrolling back near the bottom pins again.
  const gestureProps = {
    onWheel: () => void (gesture.current.at = Date.now()),
    onTouchMove: () => void (gesture.current.at = Date.now()),
    onTouchEnd: () => void (gesture.current.at = Date.now()),
    onKeyDown: () => void (gesture.current.at = Date.now()),
    onPointerDown: () => void (gesture.current = { held: true, at: Date.now() }),
    onPointerUp: () => void (gesture.current = { held: false, at: Date.now() }),
    onPointerCancel: () => void (gesture.current = { held: false, at: Date.now() }),
  };

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const near = isNearBottom(el);
    const byHand = gesture.current.held || Date.now() - gesture.current.at < GESTURE_GRACE_MS;
    if (near) stickToBottom.current = true;
    else if (byHand) stickToBottom.current = false;
    setAtBottom(near);
  };

  // The turn a search led to: shown once it is on the page, which for an old turn means fetching back to it.
  const [jump, setJump] = useState<{ threadId: string; turnId: string } | null>(null);
  useEffect(() => {
    if (!jump || jump.threadId !== selectedId || eventsLoading) return;
    const row = scrollerRef.current?.querySelector<HTMLElement>(`[data-turn="${CSS.escape(jump.turnId)}"]`);
    if (row) {
      stickToBottom.current = false;
      setAtBottom(false);
      row.scrollIntoView({ block: 'start' });
      row.classList.add('found');
      setTimeout(() => row.classList.remove('found'), 2200);
      setJump(null);
      return;
    }
    // Loaded but not drawn yet: the next render has it.
    if (events.some((e) => e.threadId === jump.threadId && e.turnId === jump.turnId)) return;
    // A thread opens at its end; an old turn is pages back, fetched until it is there.
    if (events.length === 0 || events[0].threadId !== jump.threadId) return;
    stickToBottom.current = false;
    if (hasOlder) { if (!loadingOlder) void loadOlder(); }
    else setJump(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump, selectedId, events, hasOlder, loadingOlder, eventsLoading]);

  const jumpToBottom = () => {
    const el = scrollerRef.current;
    if (!el) return;
    stickToBottom.current = true;
    setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  // The agent and directory the composer is talking to: the thread's, or the draft's for a new thread.
  const activeAgent = selected?.agent ?? draftAgent;
  const activeCwd = selected?.cwd ?? draftCwd;
  const commandsKey = `${activeAgent}\n${activeCwd}`;

  // Models of an agent other than the thread's own, for choosing what its members start with.
  const modelsAsked = useRef(new Set<string>());
  const needModels = (agent: string) => {
    if (!api || modelsByAgent[agent] || modelsAsked.current.has(agent)) return;
    modelsAsked.current.add(agent);
    api.models(agent).then((list) => setModelsByAgent((prev) => ({ ...prev, [agent]: list }))).catch(() => { modelsAsked.current.delete(agent); });
  };

  // Models for that agent, loaded once per agent.
  useEffect(() => {
    if (!api || !activeAgent || modelsByAgent[activeAgent]) return;
    api
      .models(activeAgent)
      .then((list) => setModelsByAgent((prev) => ({ ...prev, [activeAgent]: list })))
      .catch(handleError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, activeAgent]);

  // Slash commands depend on the directory (projects add their own). Claude only announces them
  // once a session has started, so the list is re-read whenever a turn finishes as well.
  // Load an initial list even during a turn, so a freshly opened page can offer queued commands.
  useEffect(() => {
    if (!api || !activeAgent || (running && commandsByKey[commandsKey])) return;
    api
      .commands(activeAgent, activeCwd || undefined)
      .then((list) => setCommandsByKey((prev) => ({ ...prev, [commandsKey]: list })))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, commandsKey, running]);

  // Import follow-up: while a thread with a session is open and the page is visible, check now and
  // then whether the terminal added turns to it. New turns arrive through the thread's event stream.
  useEffect(() => {
    if (!api || !selectedId || !selected?.agentSessionId || running || pageHidden) return;
    let stopped = false;
    const check = () => api.syncThread(selectedId).catch(() => undefined);
    void check();
    const timer = setInterval(() => {
      if (!stopped && !document.hidden) void check();
    }, 30_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // `selected` is read for agentSessionId only; the poll itself only needs the id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, selectedId, selected?.agentSessionId, running, pageHidden]);

  const loadImage = useCallback(
    (attachmentId: string) => {
      if (!api || !selectedId) return Promise.reject(new Error('no thread'));
      return api.attachment(selectedId, attachmentId);
    },
    [api, selectedId],
  );

  const loadFile = useCallback(
    (path: string) => {
      if (!api || !selectedId) return Promise.reject(new Error('no thread'));
      return api.threadFile(selectedId, path);
    },
    [api, selectedId],
  );

  // The file panel: what it shows, for the thread on screen. Switching threads closes it.
  const [files, setFiles] = useState<FilesTarget | null>(null);
  const filesSeq = useRef(0);
  useEffect(() => setFiles(null), [selectedId]);
  // A page the agent wrote, rendered in a sandboxed iframe.
  const [preview, setPreview] = useState<{ threadId: string; path: string } | null>(null);
  const openFileLink = useCallback(
    async (raw: string) => {
      if (!api || !selectedId) throw new Error('no thread');
      const ref = fileRef(raw);
      // Asked first, so a file the thread cannot show falls back to copying its path.
      const file = await api.threadText(selectedId, ref.path);
      setAgentsOpen(false);
      setFiles({ path: file.path, line: ref.line, file, seq: ++filesSeq.current });
    },
    [api, selectedId],
  );

  useEffect(() => {
    const onVisibility = () => {
      setPageHidden(document.hidden);
      if (!document.hidden) checkForUpdate();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
    // checkForUpdate only reads a ref and calls a state setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The thread on screen is being read. With the page in the background, nothing is.
  const viewingId = pageHidden ? null : selectedId;

  // Say so when something happens in a thread that is not on screen, and keep a count in the tab title.
  useEffect(() => {
    const before = seenThreads.current;
    seenThreads.current = threads;
    document.title = pageTitle(baseTitle.current, attentionCount(threads, viewingId));
    if (!before) return;
    const notice = threadNotices(before, threads, viewingId).at(-1);
    if (notice) {
      setToast({
        message: notice.message,
        action: {
          label: notice.action,
          run: () => {
            setSelectedId(notice.threadId);
            setDrawer(false);
          },
        },
      });
    }
  }, [threads, viewingId]);

  // Looking at a thread marks it read, on every device.
  const selectedUnread = Boolean(selected?.unread);
  useEffect(() => {
    if (!api || !selectedId || !selectedUnread || pageHidden) return;
    api
      .updateThread(selectedId, { unread: false })
      .then((updated) => setThreads((prev) => prev.map((t) => (t.id === updated.id ? updated : t))))
      .catch(() => undefined);
  }, [api, selectedId, selectedUnread, pageHidden]);

  /** Shows a thread that was just made here: imported, forked, or brought back from the archive. */
  const openThread = (thread: Thread, draft?: string) => {
    if (draft !== undefined) prefillComposerDraft(hostId ? `host:${hostId}:${thread.id}` : thread.id, draft);
    setThreads((prev) => [thread, ...prev.filter((t) => t.id !== thread.id)]);
    setSelectedId(thread.id);
    setView('thread');
    setDrawer(false);
    void refreshThreads(); // the server decides the order
  };

  const threadActions = useThreadActions({
    api,
    agents,
    sections,
    todos,
    onTodosChange: reloadTodos,
    onThreadOpen: openThread,
    onMarkedUnread: (thread) => {
      if (thread.id === selectedId) setSelectedId(null);
    },
    onThreadChange: (updated) => {
      setThreads((prev) => {
        if (updated.archivedAt) return prev.filter((t) => t.id !== updated.id);
        return prev.some((t) => t.id === updated.id) ? prev.map((t) => (t.id === updated.id ? updated : t)) : [updated, ...prev];
      });
      if (updated.archivedAt && selectedId === updated.id) setSelectedId(null);
      setArchiveKey((k) => k + 1);
      void refreshThreads(); // the server decides the order
    },
    onThreadRemove: (id) => {
      setThreads((prev) => prev.filter((t) => t.id !== id));
      if (selectedId === id) setSelectedId(null);
      setArchiveKey((k) => k + 1);
    },
    onSectionsChange: () => {
      api?.sections().then(setSections).catch(handleError);
      void refreshThreads();
    },
    onOpenTerminal: () => (demo ? askToConnect() : setTermOpen(true)),
    onError: handleError,
    toast: setToast,
    // The open thread is already in memory; copying it straight away keeps the browser's
    // "this came from a click" window, which the plain-http copy fallback depends on.
    // Only when all of it is: a long thread has older turns that were never loaded, and the copy
    // must not stop where the screen does.
    markdownOf: async (thread) => {
      if (thread.id === selectedId && !hasOlder) return toMarkdown(thread.title, timeline.items);
      if (!api) return '';
      return toMarkdown(thread.title, buildTimeline(await api.allEvents(thread.id)).items);
    },
  });

  const performSend = async (text: string, images: PreparedImage[], isNewThread: boolean, mentions?: AgentMention[], videos: PreparedVideo[] = []) => {
    setError(null);
    try {
      let id = selectedId;
      if (!id) {
        const t = await api.createThread({
          agent: draftAgent,
          cwd: draftCwd,
          permissionMode: draftPermission,
          workMode: draftWorkMode,
          model: draftModel,
          effort: draftEffort,
          speed: draftSpeed,
          ...(draftSectionId && isNewThread ? { sectionId: draftSectionId } : {}),
          ...(draftScratch ? { scratch: true } : draftWorktree && offer ? { worktree: true } : {}),
        });
        id = t.id;
        setSelectedId(id);
        setDraftSectionId(null);
        // Every worktree is a new branch; the next thread starts in place unless asked again.
        setDraftWorktree(false);
      }
      // Bringing an agent in with @ is itself the request to collaborate; there is no switch to find first.
      if ((draftCollaboration || mentions?.length) && !selected?.coordination) await api.configureCoordination(id, { directories: collaborationDirectories.length ? collaborationDirectories : undefined, defaults: startingDefaults, permission: memberPermission });
      stickToBottom.current = true;
      // "queue" only matters while a turn is running: then the message waits instead of being refused.
      await api.startTurn(
        id,
        text,
        images.map(({ data, mimeType }) => ({ data, mimeType })),
        { queue: true, mentions, videos: await Promise.all(videos.map(async video => (await api.uploadVideo(id!, video.file)).id)) },
      );
      void refreshThreads();
    } catch (e) {
      // The composer keeps the draft; the dialog says it will still be there.
      if (e instanceof DemoError) setConnectAsk({ reason: '连接后再发送，输入框里的内容会留着。' });
      else handleError(e);
      throw e;
    }
  };

  const send = async (text: string, images: PreparedImage[], mentions?: AgentMention[], videos: PreparedVideo[] = []) => {
    // The terminal wrote to this session after the hub last did. Both sides writing the same session
    // interleaves turns, so ask before joining in again.
    // The composer keeps the draft and its pictures until this settles, so backing out loses nothing.
    if (selectedId && selected?.terminalActivity) {
      return new Promise<void>((resolve, reject) => setPendingSend({ text, images, videos, mentions, resolve, reject }));
    }
    await performSend(text, images, true, mentions, videos);
  };

  // Stopping means stopping: messages that were waiting are not sent. Their text goes back in the box.
  const stop = () => {
    if (!selectedId) return;
    api
      .cancel(selectedId)
      .then(({ dropped, mentions }) => {
        if (dropped.length || mentions?.length) setRestore({ text: dropped.join('\n\n'), mentions, nonce: Date.now() });
      })
      .catch(handleError);
  };

  const removeQueued = (queuedId: string) => {
    if (selectedId) api.removeQueued(selectedId, queuedId).then(refreshThreads).catch(handleError);
  };

  const editQueued = async (queuedId: string) => {
    if (!selectedId) throw new Error('没有打开的线程');
    const taken = await api.removeQueued(selectedId, queuedId);
    refreshThreads();
    return { ...taken, videos: await restoreVideos(api, selectedId, taken.videos) };
  };

  const sendQueuedNow = (queuedId: string) => {
    if (selectedId) api.sendQueuedNow(selectedId, queuedId).then(refreshThreads).catch(handleError);
  };

  const decide = (approvalId: string, optionId: string | null) => {
    const body = optionId === null ? { cancel: true as const } : { optionId };
    api.decide(approvalId, body).catch(handleError);
  };

  const pick = (id: string) => {
    setSelectedId(id);
    setDrawer(false);
  };

  // The plan page takes the place of a thread, so no thread is open while it is.
  const openTodos = () => {
    setSelectedId(null);
    setView('todos');
    setDrawer(false);
  };
  const openSchedules = () => {
    setSelectedId(null);
    setView('schedules');
    setDrawer(false);
  };

  const openActivity = () => {
    setSelectedId(null);
    setView('activity');
    setDrawer(false);
  };

  const openSkills = () => {
    setSelectedId(null);
    setView('skills');
    setDrawer(false);
  };

  const openMcp = () => {
    setSelectedId(null);
    setView('mcp');
    setDrawer(false);
  };

  const newThread = (opts: { cwd?: string; sectionId?: string | null; scratch?: boolean } = {}) => {
    setSelectedId(null);
    setView('thread');
    setDrawer(false);
    if (opts.cwd !== undefined) {
      setDraftCwd(opts.cwd);
      setDraftScratch(false);
    }
    if (opts.scratch) setDraftScratch(true);
    setDraftSectionId(opts.sectionId ?? null);
  };

  // A turn a search found: its thread is opened and the conversation is brought to that turn. An
  // archived thread comes back out of the archive, as it does when opened from anywhere else.
  const openHit = async (hit: SearchHit) => {
    if (!api) return;
    try {
      let thread = threads.find((t) => t.id === hit.threadId) ?? (await api.thread(hit.threadId));
      if (thread.archivedAt) {
        thread = await api.updateThread(hit.threadId, { archived: false });
        setArchiveKey((k) => k + 1);
        setToast({ message: '已从归档恢复' });
      }
      openThread(thread);
      setJump({ threadId: hit.threadId, turnId: hit.turnId });
    } catch (e) {
      handleError(e);
    }
  };

  // A session that is already a thread may have been archived since; opening it brings it back.
  const openImported = async (threadId: string) => {
    try {
      let thread = await api.thread(threadId);
      if (thread.archivedAt) {
        thread = await api.updateThread(threadId, { archived: false });
        setArchiveKey((k) => k + 1);
        setToast({ message: '已从归档恢复' });
      }
      openThread(thread);
      setImportOpen(false);
    } catch (e) {
      handleError(e);
    }
  };

  const importAgents = agents.filter((a) => a.available && a.capabilities.history);
  const agentLabel = (id: string) => agents.find((a) => a.id === id)?.label ?? id;
  const capsOf = (id: string) => agents.find((a) => a.id === id)?.capabilities;
  const activeCaps = capsOf(activeAgent);
  const models = modelsByAgent[activeAgent] ?? [];
  const permissionModes = activeCaps?.permissionModes ?? [];
  const effortLevels = activeCaps?.effortLevels ?? [];

  // Settings shown in the composer: the thread's own, or the draft's until the first message is sent.
  const workMode = selected?.workMode ?? (selected ? 'execute' : draftWorkMode);
  const changeWorkMode = async (mode: WorkMode, execute = false) => {
    if (!selected) { setDraftWorkMode(mode); return; }
    const id = selected.id;
    setModeBusy(true);
    try {
      const updated = await api.updateThread(id, { workMode: mode });
      setThreads(prev => prev.map(t => t.id === id ? updated : t));
      if (execute) await api.startTurn(id, '按我们讨论的计划开始执行。');
    } catch (error) { handleError(error); }
    finally { setModeBusy(false); }
  };

  const permission = selected ? selected.permissionMode : draftPermission;
  const model = selected ? selected.model : draftModel;
  const effort = selected ? selected.effort : draftEffort;
  const speed = selected ? selected.speed ?? null : draftSpeed;

  const updateSelected = (patch: { speed?: string | null; permissionMode?: string; model?: string | null; effort?: string | null }) => {
    if (!selected) return;
    // Shown at once: a control that waits for the round trip snaps back to the old value first.
    const id = selected.id;
    const before = { permissionMode: selected.permissionMode, model: selected.model, effort: selected.effort, speed: selected.speed };
    setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    api
      .updateThread(id, patch)
      .then((updated) => setThreads((prev) => prev.map((t) => (t.id === updated.id ? updated : t))))
      .catch((e) => {
        setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, ...before } : t)));
        handleError(e);
      });
  };

  const pickAgent = (id: string) => {
    setDraftAgent(id);
    setDraftWorkMode('execute');
    setDraftSpeed(null);
    setDraftModel(null);
    setDraftEffort(null);
    // Each agent starts at its own level: one that cannot ask starts where it can work.
    const caps = capsOf(id);
    if (caps) setDraftPermission(startingPermission(caps));
  };

  // Adds a discovered CLI as its own instance and selects it for the new thread.
  const addDiscoveredAgent = async (found: DiscoveredAgent) => {
    if (!api) return;
    await api.addAgent({ id: found.id, adapter: found.adapter, command: [found.command] });
    const [list, more] = await Promise.all([api.agents(), api.discoverAgents()]);
    setAgents(list);
    setDiscovered(more);
  };

  // Links a signed-in account as its own instance and selects it for the new thread.
  const addAccount = async (account: DiscoveredAccount) => {
    if (!api) return;
    await api.addAgent({ id: account.id, adapter: account.adapter, label: account.label, env: account.env, account: account.email });
    const [list, rest] = await Promise.all([api.agents(), api.discoverAccounts()]);
    setAgents(list);
    setAccounts(rest);
  };

  // What the slash menu offers besides the agent's own commands. The keywords include the names
  // these have in the agents' terminals (/clear, /resume, /export, /status), so habits still work.
  const hubActions: HubAction[] = [
    { id: 'new', label: '新线程', hint: '开始一个新的对话', keywords: ['new', 'clear'] },
    { id: 'status', label: '状态', hint: '会话、模型、上下文和终端恢复命令', keywords: ['status', 'info'] },
    { id: 'term', label: '终端', hint: '在这台主机上开一个真的终端', keywords: ['term', 'terminal', 'shell', '命令行'] },
    ...(agents.some((a) => a.capabilities.quota)
      ? [{ id: 'usage', label: '额度', hint: '所有 agent 的用量、重置时间和刷新', keywords: ['usage', 'quota', '额度', 'cost'] }]
      : []),
    { id: 'skills', label: '技能', hint: '各机器各 agent 的技能，互相同步', keywords: ['skills', 'skill', '技能'] },
    { id: 'mcp', label: 'MCP', hint: '各机器各 agent 的 MCP 服务，按业务线管理', keywords: ['mcp', 'server', '业务线'] },
    ...(models.length || effortLevels.length
      ? [{ id: 'model', label: '模型与思考强度', hint: modelName(models, model), keywords: ['model', 'effort', 'thinking'] }]
      : []),
    ...(permissionModes.length
      ? [{ id: 'permission', label: '权限', hint: PERMISSION_LABELS[permission]?.label ?? '', keywords: ['permission', 'permissions', 'approvals', 'mode'] }]
      : []),
    ...(selected
      ? [
          { id: 'rename', label: '重命名', hint: '给这个线程改名', keywords: ['rename', 'name'] },
          { id: 'pin', label: selected.pinned ? '取消置顶' : '置顶', hint: '固定在侧边栏顶部', keywords: ['pin'] },
          ...(activeCaps?.fork && !forkBlocked(selected)
            ? [{ id: 'fork', label: '分叉', hint: '复制这个线程，另走一条路', keywords: ['fork', 'branch', 'clone'] }]
            : []),
          { id: 'export', label: '复制对话', hint: '整段对话复制成 Markdown', keywords: ['export', 'copy'] },
          { id: 'archive', label: '归档', hint: '从侧边栏收起，随时可以恢复', keywords: ['archive'] },
        ]
      : []),
    ...(importAgents.length ? [{ id: 'import', label: '导入历史', hint: '把终端里聊过的会话接到这里', keywords: ['import', 'resume', 'history'] }] : []),
    { id: 'appearance', label: '外观', hint: '浅色、深色和主题', keywords: ['theme', 'appearance', 'dark', 'light', '主题'] },
    { id: 'help', label: '全部命令', hint: '这个菜单里就是能用的全部命令', keywords: ['help', 'commands'] },
  ];

  const runHubAction = (id: string) => {
    // These are the hub's own machinery, which the demo has none of.
    if (demo && (id === 'term' || id === 'usage' || id === 'skills' || id === 'mcp' || id === 'import')) return askToConnect();
    if (id === 'new') return newThread();
    if (id === 'status') return setStatusOpen(true);
    if (id === 'term') return setTermOpen(true);
    if (id === 'usage') return setQuotaOpen(true);
    if (id === 'skills') return openSkills();
    if (id === 'mcp') return openMcp();
    if (id === 'export' && selected) return threadActions.copyConversation(selected);
    if (id === 'model') return setModelSignal((n) => n + 1);
    if (id === 'permission') return setPermissionSignal((n) => n + 1);
    if (id === 'import') return setImportOpen(true);
    if (id === 'appearance') return setAppearanceOpen(true);
    if (selected && (id === 'rename' || id === 'pin' || id === 'fork' || id === 'archive')) threadActions.run(id, selected);
  };

  // The hub has its own controls for these; going through the agent would leave them out of sync.
  const hiddenCommands = [...(models.length ? ['model'] : []), ...(effortLevels.length ? ['effort'] : []), ...(activeCaps?.quota ? ['usage'] : [])];

  const attachBlocked = !activeCaps?.images ? `${agentLabel(activeAgent)} 不支持发图片` : imagesBlocked(models, model);

  // The top bar names a thread's agent and directory, so the composer does not repeat them: its
  // strip is only for choosing them, before the thread exists.
  const header = selected ? null : (
    <>
      <AgentPicker agents={agents} value={draftAgent} onChange={pickAgent} accounts={accounts} onAddAccount={addAccount} />
      <ProjectPicker
        projects={projectOptions}
        machineLabel={host?.label ?? (hostId ? '远程机器' : '本机')}
        remote={Boolean(hostId)}
        cwd={draftCwd}
        scratch={draftScratch}
        scratchAvailable={scratchAvailable}
        onPick={(cwd) => {
          setDraftCwd(cwd);
          setDraftScratch(false);
        }}
        onScratch={() => setDraftScratch(true)}
        onBrowse={() => setShowDirPicker(true)}
        onNewProject={() => setProjectDialog('new')}
        onManageRoots={() => setProjectDialog('roots')}
      />
      {onHost && <MachinePicker
        hosts={hosts}
        current={hostId}
        onPick={(id) => { if (id !== hostId) onHost(id); }}
        onManage={() => setHostsOpen(true)}
      />}
      {offer && !draftScratch && <WorkspacePicker branch={offer.branch} changes={offer.changes} worktree={draftWorktree} onChange={setDraftWorktree} />}
      {draftSectionId && sections.some((s) => s.id === draftSectionId) && (
        <button
          className="context-chip"
          title="新线程会归入这个分区，点一下取消"
          onClick={() => setDraftSectionId(null)}
        >
          <IconList size={13} />
          {sections.find((s) => s.id === draftSectionId)?.name}
          <IconClose size={12} />
        </button>
      )}
    </>
  );

  // The team's own choices once there is a team; until then, what this device remembers.
  const leading = Boolean(coordination && selected && coordination.rootId === selected.id);
  const teamAgents = agents.filter((a) => a.available && a.capabilities.coordination && (!leading || coordination!.agents.includes(a.id)));
  const teamDefaults: Record<string, MemberDefault> = leading ? coordination!.defaults ?? {} : memberDefaults;
  const startingDefaults = Object.fromEntries(Object.entries(memberDefaults).filter(([id]) => teamAgents.some((a) => a.id === id)));
  const setMemberDefault = (agent: string, value: MemberDefault) => {
    const remembered = { ...memberDefaults, [agent]: value };
    setMemberDefaults(remembered);
    localStorage.setItem(memberDefaultsKey, JSON.stringify(remembered));
    if (leading && api) void api.configureCoordination(coordination!.rootId, { action: 'defaults', defaults: { ...teamDefaults, [agent]: value } }).then((team) => { setCoordination(team); void refreshThreads(); }).catch(handleError);
  };
  const teamPermission = leading ? coordination!.permission ?? 'full_access' : memberPermission;
  const chooseMemberPermission = (mode: string) => {
    setMemberPermission(mode);
    localStorage.setItem(`${memberDefaultsKey}.permission`, mode);
    // One level for everyone: what single instances were given goes with it.
    const cleared = Object.fromEntries(Object.entries(memberDefaults).map(([id, { permission: _, ...rest }]) => [id, rest]));
    setMemberDefaults(cleared);
    localStorage.setItem(memberDefaultsKey, JSON.stringify(cleared));
    if (leading && api) void api.configureCoordination(coordination!.rootId, { action: 'permission', permission: mode }).then((value) => { setCoordination(value); void refreshThreads(); }).catch(handleError);
  };
  const memberModel = (agent: AgentInfo) => {
    const value = teamDefaults[agent.id] ?? { model: null, effort: null };
    const level = value.permission ?? teamPermission;
    return (
      <MemberModel agent={agent} models={modelsByAgent[agent.id] ?? []} value={value} onNeed={needModels} onChange={(next) => setMemberDefault(agent.id, next)}
        permission={agent.capabilities.permissionModes.includes(level) ? level : undefined} onPermission={(permission) => setMemberDefault(agent.id, { ...value, permission })} />
    );
  };

  const collaborationOptions: AgentMention[] = (selected?.coordination ? selected.coordination.rootId === selected.id : activeCaps?.coordination && !(selected && running)) ? [
            ...(coordination?.members.map(m => ({ id: m.id, label: m.name, kind: 'member' as const })) ?? []),
            ...agents.filter(a => a.available && a.capabilities.coordination && (!coordination || coordination.agents.includes(a.id))).map(a => ({ id: a.id, label: a.label, kind: 'agent' as const })),
          ] : [];
  const collaborationIcon = (m: AgentMention) => agents.find((a) => a.id === (m.kind === 'agent' ? m.id : coordination?.members.find((v) => v.id === m.id)?.thread?.agent))?.icon;

  const collaborationControl = (select: (mention: AgentMention) => void, chosen: AgentMention[]) => ((activeCaps?.coordination || selected?.coordination) && <CoordinationPopover label="协作" panelClassName="coord-picker-panel" triggerClassName={`tool-btn coord-tool${selected?.coordination || draftCollaboration ? ' on' : ''}`} triggerLabel="协作" triggerTitle={selected?.coordination || draftCollaboration ? '协作已启用' : '协作'} trigger={<><IconAgents size={16} /><span>协作</span></>}>
      {close => <CollaborationMenu options={collaborationOptions} selected={chosen} icon={collaborationIcon}
        onSelect={mention => { close(); select(mention); }}
        unavailable={selected?.coordination && !leading ? '请回到主线程选择协作成员' : running ? '当前轮结束后可添加助手' : '暂无可用的协作智能体'}
        settings={<div className="coord-setup">
        <p>设置成员的目录、权限和默认模型。选择助手并发送任务后会自动启用协作。</p>
        {!selected?.coordination && <>
          <div className="coord-caption">允许使用的目录</div>
          {[...new Set([activeCwd, ...workdirs].filter(Boolean))].map(dir => <button className="pop-item compact" role="menuitemcheckbox" aria-checked={(collaborationDirectories.length ? collaborationDirectories : [activeCwd]).includes(dir)} key={dir} onClick={() => setCollaborationDirectories(prev => { const current = prev.length ? prev : [activeCwd]; return current.includes(dir) ? current.filter(v => v !== dir) : [...current, dir]; })}>{(collaborationDirectories.length ? collaborationDirectories : [activeCwd]).includes(dir) ? '已选 · ' : ''}{dir}</button>)}
          <button className="pop-item compact" disabled={running} onClick={() => {
            if (selected) void api.configureCoordination(selected.id, { directories: collaborationDirectories.length ? collaborationDirectories : [selected.cwd], defaults: startingDefaults, permission: memberPermission }).then(value => { setCoordination(value); void refreshThreads(); close(); }).catch(handleError);
            else { setDraftCollaboration(v => !v); close(); }
          }}>{draftCollaboration ? '关闭协作' : running ? '当前轮结束后可启用' : '启用协作'}</button>
        </>}
        {(!selected?.coordination || leading) && teamAgents.length > 0 && <>
          <div className="coord-caption">成员的权限</div>
          {PERMISSION_ORDER.map((mode) => <button type="button" className="pop-item compact" role="menuitemradio" aria-checked={mode === teamPermission} key={mode} title={permissionHint(mode, true)} onClick={() => chooseMemberPermission(mode)}>
            <span className="pop-item-text"><span className="pop-item-label">{PERMISSION_LABELS[mode].label}</span></span>
            {mode === teamPermission && <span className="pop-item-check"><IconCheck size={15} /></span>}
          </button>)}
          <div className="coord-caption">成员的模型与思考强度</div>
          {teamAgents.map((a) => <div className="coord-default" key={a.id}>
            <span className="pop-item-icon">{a.icon ? <AgentMark path={a.icon} size={15} /> : null}</span>
            <span className="coord-default-name">{a.label}</span>
            {memberModel(a)}
          </div>)}
        </>}
        {selected?.coordination && <button className="pop-item compact" onClick={() => { setAgentsOpen(true); setFiles(null); close(); }}>查看智能体</button>}
      </div>} />}
    </CoordinationPopover>);

  const left = (<>
    <PermissionPicker
      modes={permissionModes}
      value={permission}
      canAsk={activeCaps?.approvals ?? true}
      openSignal={permissionSignal}
      onChange={(m) => (selected ? updateSelected({ permissionMode: m }) : setDraftPermission(m))}
    />
  </>);

  // Who takes over when the thread's agent has run out of plan: another instance of the same agent
  // first (its own account, the same tools), otherwise any other agent that is up.
  const current = agents.find((a) => a.id === selected?.agent);
  const others = agents.filter((a) => a.available && a.id !== selected?.agent);
  const successor = others.find((a) => current?.adapter && a.adapter === current.adapter) ?? others[0] ?? null;

  const teamWaiting = Boolean(coordination?.members.some((m) => m.thread?.waiting));
  const teamRunning = coordination?.members.filter((m) => m.thread?.status === 'running').length ?? 0;
  const teamShown = Boolean(selected?.coordination && (selected.coordination.rootId !== selected.id || selected.coordination.children > 0) && !onTodos && !onActivity && !onSkills && hostUp);
  const teamNote = teamWaiting ? '待批准' : teamRunning ? `${teamRunning} 运行中` : selected?.coordination?.paused ? '已暂停' : '';

  // Older daemons advertise /compact before they expose the dedicated capability.
  const canCompact = activeCaps?.compact ?? (commandsByKey[commandsKey] ?? []).some((command) => command.name === 'compact' && command.kind !== 'skill');

  const right = (
    <>
      {selected && (timeline.usage || canCompact) && <UsageMeter
        usage={timeline.usage}
        onCompact={canCompact ? () => send('/compact', []) : undefined}
        running={running}
        compactQueued={selected.queued?.some((message) => message.text.trim() === '/compact')}
        compactDisabled={(selected.queued?.length ?? 0) >= MAX_QUEUED}
      />}
      <ModelPicker
      models={models}
      model={model}
      efforts={effortLevels}
      effort={effort}
      speed={speed}
      onSpeed={activeCaps?.speed ? v => selected ? updateSelected({ speed: v }) : setDraftSpeed(v) : undefined}
      onDiagnose={() => setObservability('diagnostics')}
      openSignal={modelSignal}
      onModel={(v) => {
        if (selected) return updateSelected({ model: v }); // the daemon drops an effort the new model lacks
        setDraftModel(v);
        if (draftSpeed && !speedsForModel(models, v).some(s => s.id === draftSpeed)) setDraftSpeed(null);
        if (draftEffort && !effortsForModel(models, v, effortLevels).includes(draftEffort)) setDraftEffort(null);
      }}
      onEffort={(v) => (selected ? updateSelected({ effort: v }) : setDraftEffort(v))}
      />
    </>
  );

  return (
    <div className={`app${listOpen ? ' drawer-open' : ''}${sidebarHidden && !compact ? ' sidebar-hidden' : ''}`}>
      {showDirPicker && (
        <DirectoryPicker
          api={api}
          roots={workdirs}
          selected={draftCwd}
          machine={host?.label ?? (hostId ? '远程机器' : '本机')}
          onRootsChange={applyWorkdirs}
          onManageRoots={() => {
            setShowDirPicker(false);
            setProjectDialog('roots');
          }}
          onSelect={(cwd) => {
            setDraftCwd(cwd);
            setDraftScratch(false);
          }}
          onClose={() => setShowDirPicker(false)}
        />
      )}
      {projectDialog === 'new' && (
        <NewProjectDialog
          api={api}
          roots={workdirs}
          onCancel={() => setProjectDialog(null)}
          onCreated={(path) => {
            setProjectDialog(null);
            setDraftCwd(path);
            setDraftScratch(false);
            setToast({ message: `已新建项目 ${folderName(path)}` });
          }}
        />
      )}
      {projectDialog === 'roots' && <RootsDialog api={api} roots={roots} onChange={applyWorkdirs} onCancel={() => setProjectDialog(null)} />}
      <aside className="sidebar">
        <Sidebar
          threads={threads.filter((t) => !t.coordination || t.coordination.rootId === t.id || !threads.some((r) => r.id === t.coordination!.rootId))}
          members={teamMembers}
          sections={sections}
          agents={agents}
          selectedId={selectedId}
          onSelect={pick}
          onNew={() => newThread()}
          onNewIn={newThread}
          compact={compact}
          onSearch={api ? (q) => api.search(q) : undefined}
          onOpenHit={(hit) => void openHit(hit)}
          onOpenSettings={(x, y) => setSettingsAt({ x, y })}
          hosts={hosts}
          hostId={hostId}
          onHost={onHost && ((id) => id !== hostId && onHost(id, 'list'))}
          hostDown={Boolean(host) && !hostUp}
          onHide={compact ? undefined : toggleSidebar}
          onThreadMenu={threadActions.openThreadMenu}
          onSectionMenu={threadActions.openSectionMenu}
          onNewSection={threadActions.newSection}
          onOpenTodos={openTodos}
          todosActive={onTodos}
          onOpenSchedules={openSchedules}
          schedulesActive={onSchedules}
          onOpenActivity={openActivity}
          activityActive={onActivity}
          notice={demo && compact ? <DemoBar compact onConnect={askToConnect} /> : undefined}
        />
      </aside>

      <main className="main" ref={mainRef}>
        <header className="topbar">
          <button className="icon-btn menu-btn" aria-label="打开线程列表" aria-expanded={listOpen} onClick={() => setDrawer((v) => !v)}>
            {compact ? <IconBack size={22} /> : <IconMenu />}
          </button>
          {/* With the list put away, the way back and a new thread move up here. */}
          {sidebarHidden && !compact && (
            <div className="topbar-lead">
              <button className="icon-btn" aria-label="显示侧边栏" title={`显示侧边栏（${SIDEBAR_SHORTCUT}）`} onClick={toggleSidebar}>
                <IconSidebar />
              </button>
              <button className="icon-btn" aria-label="新线程" title="新线程" onClick={() => newThread()}>
                <IconEdit />
              </button>
            </div>
          )}
          <div className="topbar-heading">
            {/* The plan page carries its own heading. */}
            <div className="topbar-title">{host && !hostUp ? host.label : onTodos || onSkills || onSchedules ? '' : selected ? selected.title : '新线程'}</div>
            {!selected && !onTodos && !onActivity && !onSkills && !onSchedules && host && hostUp && <div className="topbar-sub">{host.label}</div>}
            {selected && (
              <div className="topbar-sub" title={selected.cwd}>
                {agentLabel(selected.agent)} ·{' '}
                {selected.scratch ? '不在项目中' : selected.worktree ? `${folderName(selected.worktree.of)} · ${selected.worktree.branch}` : folderName(selected.cwd)}
                {host && ` · ${host.label}`}
              </div>
            )}
          </div>
          {selected && (
            <div className="topbar-actions">
              {teamShown && selected.coordination!.rootId !== selected.id && (
                <button className="coord-status" onClick={() => pick(selected.coordination!.rootId)}>
                  <IconBack size={14} /><span>返回主线程</span>
                </button>
              )}
              {teamShown && selected.coordination!.rootId === selected.id && !(roomy && !agentsOpen && !files && coordination) && (
                <button className={`coord-status${teamWaiting ? ' attention' : ''}`} aria-label="查看智能体" aria-pressed={agentsOpen} title={`${selected.coordination!.children} 个智能体`} onClick={() => { setAgentsStart(null); setAgentsOpen((v) => !v); setFiles(null); }}>
                  <IconAgents size={15} />
                  <span>{selected.coordination!.children}</span>
                  {teamNote && <span className="coord-status-note">{teamNote}</span>}
                </button>
              )}
              <button
                className={`icon-btn topbar-files${files ? ' on' : ''}`}
                aria-label="文件"
                aria-pressed={Boolean(files)}
                title="文件"
                onClick={() => { setAgentsOpen(false); setFiles(files ? null : { path: null, seq: ++filesSeq.current }); }}
              >
                <IconFiles />
              </button>
              {!compact && (
                <button className="icon-btn topbar-term" aria-label="打开终端" title="终端" onClick={() => (demo ? askToConnect() : setTermOpen(true))}>
                  <IconTerminal />
                </button>
              )}
              <button className="icon-btn topbar-new" aria-label="新线程" onClick={() => newThread()}>
                <IconEdit />
              </button>
              <button
                className="icon-btn topbar-more"
                aria-label="这个线程的更多操作"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  threadActions.openThreadMenu(selected, rect.right - 200, rect.bottom + 6);
                }}
              >
                <IconMore />
              </button>
            </div>
          )}
        </header>

        {demo && <DemoBar compact={compact} onConnect={askToConnect} />}

        {selected && !onTodos && !onActivity && !onSkills && !onSchedules && hostUp && <HandoverTrail thread={selected} threads={threads} agentLabel={agentLabel} onSelect={pick} />}

        {error && (
          <div className="banner" role="alert">
            <span>{error}</span>
            <button className="icon-btn" aria-label="关闭提示" onClick={() => setError(null)}>
              ×
            </button>
          </div>
        )}

        {host && !hostUp ? (
          // The machine's threads are over there; until it is back there is only this to say.
          <div key="host-down" className="scroller">
            <HostDown host={host} onRetry={() => api.reconnectHost(host.id).catch(() => undefined).then(reloadHosts)} />
          </div>
        ) : onSkills ? (
          // The skills page spans the machines from the hub, so it carries its own scroller too.
          <div key="skills" className="scroller">
            <SkillsPage api={api} token={token} hostId={hostId} hosts={hosts} agents={agents} onError={handleError} />
          </div>
        ) : onMcp ? (
          // The same: one view across every machine, with a scroller of its own.
          <div key="mcp" className="scroller">
            <McpPage api={api} token={token} hostId={hostId} hosts={hosts} agents={agents} onError={handleError} />
          </div>
        ) : onSchedules ? (
          // The same: a document-style page with a scroller of its own.
          <div key="schedules" className="scroller">
            <SchedulesPage
              api={api}
              schedules={schedules}
              agents={agents}
              workdirs={workdirs}
              refreshKey={schedulesKey}
              onReload={reloadSchedules}
              onOpenThread={(id) => pick(id)}
              onError={handleError}
            />
          </div>
        ) : onTodos ? (
          // A scroller of its own: the thread's one pins itself to the bottom, a document starts at the top.
          <div key="todos" className="scroller">
            <TodosPage
              api={api}
              todos={todos}
              threads={threads}
              refreshKey={todosKey}
              onReload={reloadTodos}
              onChange={setTodos}
              onOpenThread={pick}
              onError={handleError}
            />
          </div>
        ) : onActivity ? (
          // The same document shape: days from the top, each conversation's asks under its name.
          <div key="activity" className="scroller">
            <ActivityPage api={api} agents={agents} onOpenThread={pick} onError={handleError} />
          </div>
        ) : (
        <div key="thread" className="scroller" ref={scrollerRef} onScroll={onScroll} {...gestureProps}>
          {selected && <TurnRuler scrollerRef={scrollerRef} previews={turnPreviewMap} />}
          {selected && eventsLoading && <div className="loading-note">加载中…</div>}
          {selected ? (
            <ThreadView
              items={timeline.items}
              roots={threadRoots}
              loadImage={loadImage}
              loadFile={loadFile}
              onOpenFile={openFileLink}
              onPreview={selected ? (path) => setPreview({ threadId: selected.id, path }) : undefined}
              onDecide={decide}
              onAnswer={(id, answer) => api.answerInput(id, answer)}
              hasOlder={hasOlder}
              loadingOlder={loadingOlder}
              onLoadOlder={loadOlder}
              // Under each answer, like Codex: one click copies the thread up to there and opens the
              // copy. Only once there is a conversation to fork; a click while it cannot run says why.
              // The button appears the moment the log says a turn is over; the thread list hears of it
              // a beat later, so the log's word on whether a turn is running is the one to go by.
              onFork={
                selected.agentSessionId && activeCaps?.fork
                  ? (turnId) => threadActions.forkAt(timeline.running ? selected : { ...selected, status: 'idle' }, turnId)
                  : undefined
              }
              forkAnyTurn={Boolean(activeCaps?.forkAt)}
              takeover={successor ? {
                label: successor.label,
                busy: takingOver,
                go: () => {
                  setTakingOver(true);
                  void threadActions.takeOver(selected, successor.id).finally(() => setTakingOver(false));
                },
                choose: () => threadActions.handover(selected),
              } : null}
            />
          ) : (
            <div className="empty">
              <h2>{draftScratch ? '我们应该做些什么？' : `我们应该在 ${folderName(draftCwd) || '这里'} 中做些什么？`}</h2>
            </div>
          )}
        </div>
        )}

        <div className="jump-anchor">
          {selected && !atBottom && (
            <button className="jump-btn" aria-label="回到底部" onClick={jumpToBottom}>
              <IconArrowDown size={17} />
            </button>
          )}
        </div>

        {/* A team at work is shown where there is room to spare: a card in the margin on a wide
            screen, otherwise a mark in the top bar. Nothing is added above the composer. */}
        {teamShown && roomy && !agentsOpen && !files && coordination && coordination.rootId === selected!.id && (
          <TeamCard team={coordination} agents={agents} onOpen={(member) => { setAgentsStart(member ?? null); setAgentsOpen(true); setFiles(null); }} />
        )}

        {!onTodos && !onActivity && !onSkills && !(host && !hostUp) && (
        <Composer
          draftKey={hostId ? `host:${hostId}:${selectedId ?? 'new'}` : selectedId ?? 'new'}
          running={running}
          disabled={modeBusy || (!selected && !draftCwd)}
          placeholder={demo ? '连接 hub 后就能发消息' : workMode === 'plan' && !running ? '先分析和讨论方案' : selected ? (running ? '追加一条，这一轮结束后发送' : '继续这个线程') : draftScratch ? '随便问点什么' : `在 ${folderName(draftCwd) || '工作目录'} 中开始`}
          onSend={send}
          mentionOptions={collaborationOptions}
          mentionIcon={collaborationIcon}
          collaboration={collaborationControl}
          mentionExtra={(m) => { const a = agents.find((v) => v.id === m.id); return a ? memberModel(a) : null; }}
          mentionDirectories={coordination?.directories ?? (collaborationDirectories.length ? collaborationDirectories : [activeCwd])}
          onStop={stop}
          planAction={selected && workMode === 'plan' && !running && timeline.items.some(it => it.kind === 'assistant' || it.kind === 'proposal') ? <><span>可以继续讨论，也可以开始执行</span><button className="primary" disabled={modeBusy} onClick={() => void changeWorkMode('execute', true)}>开始执行</button></> : null}
          header={header}
          planMode={activeCaps?.workModes?.includes('plan') ? { active: workMode === 'plan', disabled: running || modeBusy, onChange: active => void changeWorkMode(active ? 'plan' : 'execute') } : undefined}
          left={left}
          right={right}
          commands={commandsByKey[commandsKey] ?? []}
          goal={activeCaps?.goal}
          actions={hubActions}
          hiddenCommands={hiddenCommands}
          onAction={runHubAction}
          attachBlocked={attachBlocked}
          attachNote={imagesNote(models, model)}
          onError={setError}
          queued={selected?.queued ?? []}
          onRemoveQueued={removeQueued}
          onEditQueued={editQueued}
          onSendQueuedNow={sendQueuedNow}
          restore={restore}
          note={noteSignal}
          onNotesChange={onNotesChange}
          lastSent={selected ? lastSent : null}
        />
        )}
      </main>

      {agentsOpen && coordination && <AgentPanel key={`${coordination.rootId}:${agentsStart ?? ''}`} start={agentsStart} api={api} team={coordination} agents={agents} memberModel={(thread) => {
        const a = agents.find((v) => v.id === thread.agent);
        return a ? <MemberModel agent={a} models={modelsByAgent[a.id] ?? []} value={{ model: thread.model ?? null, effort: thread.effort ?? null }} onNeed={needModels} onChange={({ model, effort }) => { void api.updateThread(thread.id, { model, effort }).then(() => refreshThreads()).catch(handleError); }}
          permission={a.capabilities.permissionModes.length ? thread.permissionMode : undefined} onPermission={(permissionMode) => { void api.updateThread(thread.id, { permissionMode }).then(() => refreshThreads()).catch(handleError); }} /> : null;
      }} leadAgent={threads.find((t) => t.id === coordination.rootId)?.agent} phone={compact} onClose={() => setAgentsOpen(false)} onOpen={thread => { openThread(thread); setAgentsOpen(false); }} onAdjust={name => { setAgentsOpen(false); setSelectedId(coordination.rootId); setRestore({ text: `请调整「${name}」的任务：`, nonce: Date.now() }); }} onRefresh={() => { void refreshThreads(); }} onError={handleError} />}
      {files && selected && api && <FilesPanel api={api} threadId={selected.id} target={files} phone={compact} onClose={() => setFiles(null)} />}
      {preview && api && (
        <PreviewPanel api={api} threadId={preview.threadId} path={preview.path} onClose={() => setPreview(null)} onError={handleError} />
      )}
      {termOpen && (
        <TerminalPanel
          api={api}
          cwd={selected?.cwd || draftCwd || workdirs[0] || ''}
          toast={setToast}
          onClose={() => setTermOpen(false)}
          onError={handleError}
        />
      )}
      {archiveOpen && (
        <ArchivePanel
          api={api}
          agents={agents}
          refreshKey={archiveKey}
          onRestore={(t) => threadActions.run('restore', t)}
          onDelete={(t) => threadActions.run('delete', t)}
          onClose={() => setArchiveOpen(false)}
          onError={handleError}
        />
      )}
      {statusOpen && (
        <StatusPanel
          thread={selected}
          agentLabel={agentLabel(activeAgent)}
          model={modelName(models, model)}
          permission={permissionModes.length ? permission : ''}
          directory={activeCwd}
          usage={selected ? timeline.usage : null}
          usageCommand={['usage', 'cost', 'session'].find((name) => (commandsByKey[commandsKey] ?? []).some((c) => c.name === name)) ?? null}
          onOpenQuota={agents.some((a) => a.capabilities.quota) ? () => setQuotaOpen(true) : undefined}
          onRunCommand={(text) => void send(text, []).catch(() => undefined)}
          onClose={() => setStatusOpen(false)}
        />
      )}
      {observability && api && <ObservabilityPanel key={hostId ?? 'local'} api={api} agents={agents} initial={observability} focusAgent={activeAgent} onResult={result => { if (result.state === 'ready' || result.state === 'empty') setModelsByAgent(previous => ({ ...previous, [result.agent]: result.models })); }} onClose={() => setObservability(null)} />}
      {quotaOpen && api && <QuotaBoard api={api} agents={agents} current={onTodos || onSkills ? undefined : activeAgent} onClose={() => setQuotaOpen(false)} onError={handleError} />}
      {addAgentOpen && (
        <AddAgentDialog
          found={discovered}
          onAdd={addDiscoveredAgent}
          onClose={() => {
            setAddAgentOpen(false);
          }}
        />
      )}
      {importOpen && (
        <ImportPanel
          api={api}
          agents={importAgents}
          onImported={(thread) => {
            openThread(thread);
            setImportOpen(false);
            setToast({ message: '已导入' });
          }}
          onOpen={(threadId) => void openImported(threadId)}
          onClose={() => setImportOpen(false)}
          onError={handleError}
        />
      )}
      {pendingSend && (
        <Dialog
          title="这个会话刚在终端里用过"
          message="终端和网页写的是同一个会话，两边轮流发会把顺序搅乱。确认要在这里继续发送吗？"
          confirmLabel="仍然发送"
          onCancel={() => {
            pendingSend.reject(new Error('not sent'));
            setPendingSend(null);
          }}
          onConfirm={() => {
            const p = pendingSend;
            setPendingSend(null);
            performSend(p.text, p.images, false, p.mentions, p.videos).then(p.resolve, p.reject);
          }}
        />
      )}
      {settingsAt && (
        <Menu
          label="配置"
          x={settingsAt.x}
          y={settingsAt.y}
          corner="bottom-right"
          onClose={() => setSettingsAt(null)}
          items={[
            // The demo's way in. The look works as it is; the hub's own machinery is left out.
            ...(demo
              ? [
                  {
                    id: 'connect',
                    label: '连接 hub',
                    icon: IconSignIn,
                    onSelect: () => {
                      setDrawer(false);
                      askToConnect();
                    },
                  },
                  'separator' as const,
                ]
              : []),
            {
              id: 'appearance',
              label: '外观',
              icon: IconPalette,
              onSelect: () => {
                setAppearanceOpen(true);
                setDrawer(false);
              },
            },
            {
              id: 'archive',
              label: '已归档',
              icon: IconArchive,
              onSelect: () => {
                setArchiveOpen(true);
                setDrawer(false);
              },
            },
            ...(agents.some((a) => a.capabilities.quota)
              ? [
                  {
                    id: 'quota',
                    label: '额度',
                    icon: IconGauge,
                    onSelect: () => {
                      setQuotaOpen(true);
                      setDrawer(false);
                    },
                  },
                ]
              : []),
            ...(discovered.length > 0
              ? [
                  {
                    id: 'add-agent',
                    label: '添加 agent',
                    icon: IconPlus,
                    onSelect: () => {
                      setAddAgentOpen(true);
                      setDrawer(false);
                    },
                  },
                ]
              : []),
            ...(demo
              ? []
              : [
                  { id: 'observability', label: '用量与诊断', icon: IconGauge, onSelect: () => { setObservability('usage'); setDrawer(false); } },
                  { id: 'skills', label: '技能', icon: IconSparkle, onSelect: openSkills },
                  { id: 'mcp', label: 'MCP', icon: IconGlobe, onSelect: openMcp },
                  {
                    id: 'hosts',
                    label: '机器',
                    icon: IconServer,
                    onSelect: () => {
                      setHostsOpen(true);
                      setDrawer(false);
                    },
                  },
                ]),
            ...(importAgents.length
              ? [
                  {
                    id: 'import',
                    label: '导入历史',
                    icon: IconImport,
                    onSelect: () => {
                      setImportOpen(true);
                      setDrawer(false);
                    },
                  },
                ]
              : []),
            // Signing out costs the saved token, so it asks first.
            ...(demo ? [] : ['separator' as const, { id: 'sign-out', label: '退出', icon: IconSignOut, danger: true, onSelect: () => setConfirmSignOut(true) }]),
          ]}
        />
      )}
      {hostsOpen && <HostsPanel api={api} hosts={hosts} onChanged={reloadHosts} onClose={() => setHostsOpen(false)} onError={handleError} />}
      {appearanceOpen && (
        <AppearancePanel appearance={appearance} theme={theme} onChange={setAppearance} onClose={() => setAppearanceOpen(false)} />
      )}
      {connectAsk && <ConnectDialog reason={connectAsk.reason} onCancel={() => setConnectAsk(null)} onConnected={(t) => onToken(t)} />}
      {confirmSignOut && (
        <Dialog
          title="退出登录？"
          message="这台设备上保存的 token 会被清除，回到示例数据。"
          confirmLabel="退出"
          onCancel={() => setConfirmSignOut(false)}
          onConfirm={() => {
            setConfirmSignOut(false);
            setDrawer(false);
            signOut();
          }}
        />
      )}
      {sideAsk && (
        <SideChat
          api={api}
          agent={activeAgent}
          agentLabel={agentLabel(activeAgent)}
          cwd={activeCwd}
          permissionMode={permission}
          model={model}
          effort={effort}
          quoteText={sideAsk.text}
          sourceTitle={selected?.title ?? null}
          forkSourceId={selected && activeCaps?.fork && !forkBlocked(selected) ? selected.id : null}
          attachBlocked={attachBlocked}
          onClose={() => setSideAsk(null)}
          onError={handleError}
          onThreadCreated={(t) => setThreads((prev) => [t, ...prev.filter((x) => x.id !== t.id)])}
        />
      )}
      {threadActions.layer}
      <Toast toast={toast} onDismiss={dismissToast} />
      <NoteMarks marks={noteMarks} scrollerRef={scrollerRef} />
      <SelectionMenu
        onNote={(quote, comment, range) => {
          const id = `note-${Date.now()}`;
          noteRanges.current.set(id, range);
          setNoteSignal({ id, quote, comment, nonce: Date.now() });
        }}
        onSideAsk={(text) => setSideAsk({ text, nonce: Date.now() })}
      />
    </div>
  );
}
