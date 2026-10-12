import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Api,
  AuthError,
  loadToken,
  saveToken,
  type AgentInfo,
  type ModelOption,
  type Section,
  type SlashCommand,
  type Thread,
  type Todo,
} from './api';
import type { HubAction } from './commands';
import { useAppearance, useIsCompact, useListSwipe } from './hooks';
import type { PreparedImage } from './images';
import { attentionCount, pageTitle, threadNotices } from './notices';
import { folderName } from './paths';
import { PERMISSION_LABELS, startingPermission } from './permissions';
import { buildTimeline, toMarkdown, turnPreviews, type StoredEvent } from './timeline';
import { newerBuildAvailable } from './version';
import { AppearancePanel } from './components/AppearancePanel';
import { ArchivePanel } from './components/ArchivePanel';
import { Composer } from './components/Composer';
import { DirectoryPicker } from './components/DirectoryPicker';
import { Dialog } from './components/Dialog';
import { ImportPanel } from './components/ImportPanel';
import { Menu } from './components/Menu';
import { StatusPanel } from './components/StatusPanel';
import { TerminalPanel } from './components/TerminalPanel';
import { QuotaPanel } from './components/QuotaPanel';
import { SelectionMenu } from './components/SelectionMenu';
import { SideChat } from './components/SideChat';
import { TodosPage } from './components/TodosPage';
import { AgentPicker, type DiscoveredAccount, type DiscoveredAgent, effortsForModel, imagesBlocked, imagesNote, modelName, ModelPicker, PermissionPicker, UsageMeter, WorkspacePicker } from './components/Pickers';
import { Sidebar } from './components/Sidebar';
import { forkBlocked, useThreadActions } from './components/ThreadActions';
import { ThreadView } from './components/ThreadView';
import { TurnRuler } from './components/TurnRuler';
import { Toast, type ToastState } from './components/Toast';
import { TokenGate } from './components/TokenGate';
import { IconArchive, IconArrowDown, IconChevron, IconClose, IconEdit, IconFolder, IconImport, IconList, IconMenu, IconMore, IconPalette, IconSignOut, IconTerminal } from './components/icons';

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

export function App() {
  const [token, setToken] = useState(loadToken);
  const [authMessage, setAuthMessage] = useState<string | undefined>();
  const api = useMemo(() => (token ? new Api(token) : null), [token]);

  const [agents, setAgents] = useState<AgentInfo[]>([]);
  /** CLIs on PATH that look like extra agents, offered in the picker. */
  const [discovered, setDiscovered] = useState<DiscoveredAgent[]>([]);
  /** Accounts of multi-account agents already signed in here, offered in the picker. */
  const [accounts, setAccounts] = useState<DiscoveredAccount[]>([]);
  const [workdirs, setWorkdirs] = useState<string[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  /** What the main area shows: a thread (or the blank one a new thread starts from), or the plan page. */
  // The plan page has an address of its own, so a reload or a bookmark lands back on it.
  const [view, setView] = useState<'thread' | 'todos'>(() => (window.location.hash === TODOS_HASH ? 'todos' : 'thread'));
  /** Bumped by daemon broadcasts, so the open plan page reloads. */
  const [todosKey, setTodosKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [draftAgent, setDraftAgent] = useState('claude');
  const [draftCwd, setDraftCwd] = useState('');
  // A new thread may start in a git worktree of its directory; offered only when the directory is in a repository.
  const [draftWorktree, setDraftWorktree] = useState(false);
  const [worktreeOffer, setWorktreeOffer] = useState<{ cwd: string; branch: string | null; changes: number } | null>(null);
  const [draftSectionId, setDraftSectionId] = useState<string | null>(null);
  const [draftPermission, setDraftPermission] = useState('auto_edit');
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [draftEffort, setDraftEffort] = useState<string | null>(null);
  const [modelsByAgent, setModelsByAgent] = useState<Record<string, ModelOption[]>>({});
  const [commandsByKey, setCommandsByKey] = useState<Record<string, SlashCommand[]>>({});
  const [drawer, setDrawer] = useState(false);
  // On a phone the thread list is a page under the conversation; `drawer` slides the conversation aside.
  const compact = useIsCompact();
  const listOpen = drawer && compact;
  useListSwipe(compact && Boolean(token), listOpen, setDrawer);
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
  const [quotaAgent, setQuotaAgent] = useState<{ id: string; label: string } | null>(null);
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
  const [restore, setRestore] = useState<{ text: string; nonce: number } | null>(null);
  // Text quoted out of a message by selecting it.
  const [quoteSignal, setQuoteSignal] = useState<{ text: string; nonce: number } | null>(null);
  // The passage a side chat was opened for, if one is open.
  const [sideAsk, setSideAsk] = useState<{ text: string; nonce: number } | null>(null);
  // A message waiting for the user to confirm sending into a session the terminal also used.
  const [pendingSend, setPendingSend] = useState<{ text: string; images: PreparedImage[]; resolve: () => void; reject: (e: unknown) => void } | null>(null);
  const [pageHidden, setPageHidden] = useState(() => document.hidden);
  const baseTitle = useRef(document.title);
  const seenThreads = useRef<Thread[] | null>(null);

  const timeline = useMemo(() => buildTimeline(events), [events]);
  const turnPreviewMap = useMemo(() => turnPreviews(timeline.items), [timeline.items]);
  const selected = threads.find((t) => t.id === selectedId) ?? null;
  const onTodos = view === 'todos' && !selectedId;

  // The address follows what the main area shows. Replaced, not pushed: going between the page and
  // threads is not a trail for the back button to walk.
  useEffect(() => {
    const want = onTodos ? TODOS_HASH : '';
    if (window.location.hash !== want) {
      window.history.replaceState(window.history.state, '', want || window.location.pathname + window.location.search);
    }
  }, [onTodos]);

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

  // An address typed or followed while the page is open.
  useEffect(() => {
    const onHash = () => {
      if (window.location.hash === TODOS_HASH) {
        setSelectedId(null);
        setView('todos');
        setDrawer(false);
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Both spellings of the thread's directory; kept stable so the thread view is not re-rendered for nothing.
  const threadRoots = useMemo(() => (selected ? [selected.cwd, selected.cwdReal] : []), [selected?.cwd, selected?.cwdReal]);
  const running = timeline.running || selected?.status === 'running';

  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  // The thread on screen, for answers that arrive after the user has moved on.
  const shownThread = useRef<string | null>(null);
  shownThread.current = selectedId;
  // Whether the user has a hand on the scroller, and when they last did.
  const gesture = useRef({ held: false, at: 0 });

  const signOut = (msg?: string) => {
    saveToken('');
    setToken('');
    setThreads([]);
    setSelectedId(null);
    setAuthMessage(msg);
  };

  const handleError = (e: unknown) => {
    if (e instanceof AuthError) signOut('token 无效或已过期，请重新输入');
    else setError(message(e));
  };

  const refreshThreads = () => api?.threads().then(setThreads).catch(() => undefined);
  const reloadTodos = useCallback(() => api?.todos().then(setTodos).catch(() => undefined), [api]);
  const dismissToast = useCallback(() => setToast(null), []);

  // Initial data once we have a token.
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    (async () => {
      try {
        const [a, c, t, s, td] = await Promise.all([
          api.agents(),
          api.workdirs(),
          api.threads(),
          api.sections(),
          api.todos().catch(() => []),
        ]);
        if (cancelled) return;
        setAgents(a);
        setWorkdirs(c.workdirs);
        setThreads(t);
        setSections(s);
        setTodos(td);
        setDraftCwd((cur) => cur || c.workdirs[0] || '');
        const first = a.find((x) => x.available);
        setDraftAgent(first?.id ?? 'claude');
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
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
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
  useEffect(() => {
    if (!api || !activeAgent || running) return;
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
  const openThread = (thread: Thread) => {
    setThreads((prev) => [thread, ...prev.filter((t) => t.id !== thread.id)]);
    setSelectedId(thread.id);
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
    onOpenTerminal: () => setTermOpen(true),
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

  if (!api) {
    return (
      <TokenGate
        message={authMessage}
        onSubmit={(t) => {
          saveToken(t);
          setAuthMessage(undefined);
          setToken(t);
        }}
      />
    );
  }

  const performSend = async (text: string, images: PreparedImage[], isNewThread: boolean) => {
    setError(null);
    try {
      let id = selectedId;
      if (!id) {
        const t = await api.createThread({
          agent: draftAgent,
          cwd: draftCwd,
          permissionMode: draftPermission,
          model: draftModel,
          effort: draftEffort,
          ...(draftSectionId && isNewThread ? { sectionId: draftSectionId } : {}),
          ...(draftWorktree && offer ? { worktree: true } : {}),
        });
        id = t.id;
        setSelectedId(id);
        setDraftSectionId(null);
        // Every worktree is a new branch; the next thread starts in place unless asked again.
        setDraftWorktree(false);
      }
      stickToBottom.current = true;
      // "queue" only matters while a turn is running: then the message waits instead of being refused.
      await api.startTurn(
        id,
        text,
        images.map(({ data, mimeType }) => ({ data, mimeType })),
        { queue: true },
      );
      void refreshThreads();
    } catch (e) {
      handleError(e);
      throw e;
    }
  };

  const send = async (text: string, images: PreparedImage[]) => {
    // The terminal wrote to this session after the hub last did. Both sides writing the same session
    // interleaves turns, so ask before joining in again.
    // The composer keeps the draft and its pictures until this settles, so backing out loses nothing.
    if (selectedId && selected?.terminalActivity) {
      return new Promise<void>((resolve, reject) => setPendingSend({ text, images, resolve, reject }));
    }
    await performSend(text, images, true);
  };

  // Stopping means stopping: messages that were waiting are not sent. Their text goes back in the box.
  const stop = () => {
    if (!selectedId) return;
    api
      .cancel(selectedId)
      .then(({ dropped }) => {
        if (dropped.length) setRestore({ text: dropped.join('\n\n'), nonce: Date.now() });
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
    return taken;
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

  const newThread = (opts: { cwd?: string; sectionId?: string | null } = {}) => {
    setSelectedId(null);
    setView('thread');
    setDrawer(false);
    if (opts.cwd !== undefined) setDraftCwd(opts.cwd);
    setDraftSectionId(opts.sectionId ?? null);
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
  const permission = selected ? selected.permissionMode : draftPermission;
  const model = selected ? selected.model : draftModel;
  const effort = selected ? selected.effort : draftEffort;

  const updateSelected = (patch: { permissionMode?: string; model?: string | null; effort?: string | null }) => {
    if (!selected) return;
    api
      .updateThread(selected.id, patch)
      .then((updated) => setThreads((prev) => prev.map((t) => (t.id === updated.id ? updated : t))))
      .catch(handleError);
  };

  const pickAgent = (id: string) => {
    setDraftAgent(id);
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
    await api.addAgent({ id: account.id, adapter: account.adapter, label: account.label, env: account.env });
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
    ...(activeCaps?.quota
      ? [{ id: 'usage', label: '额度', hint: '套餐用量和重置时间', keywords: ['usage', 'quota', '额度', 'cost'] }]
      : []),
    ...(models.length || effortLevels.length
      ? [{ id: 'model', label: '模型与思考强度', hint: modelName(models, model), keywords: ['model', 'effort', 'thinking'] }]
      : []),
    ...(permissionModes.length
      ? [{ id: 'permission', label: '权限', hint: PERMISSION_LABELS[permission]?.label ?? '', keywords: ['permission', 'permissions', 'mode'] }]
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
    if (id === 'new') return newThread();
    if (id === 'status') return setStatusOpen(true);
    if (id === 'term') return setTermOpen(true);
    if (id === 'usage' && activeCaps?.quota) return setQuotaAgent({ id: activeAgent, label: agentLabel(activeAgent) });
    if (id === 'export' && selected) return threadActions.copyConversation(selected);
    if (id === 'model') return setModelSignal((n) => n + 1);
    if (id === 'permission') return setPermissionSignal((n) => n + 1);
    if (id === 'import') return setImportOpen(true);
    if (id === 'appearance') return setAppearanceOpen(true);
    if (selected && (id === 'rename' || id === 'pin' || id === 'fork' || id === 'archive')) threadActions.run(id, selected);
  };

  // The hub has its own controls for these; going through the agent would leave them out of sync.
  const hiddenCommands = [...(models.length ? ['model'] : []), ...(effortLevels.length ? ['effort'] : [])];

  const attachBlocked = !activeCaps?.images ? `${agentLabel(activeAgent)} 不支持发图片` : imagesBlocked(models, model);

  // The top bar names a thread's agent and directory, so the composer does not repeat them: its
  // strip is only for choosing them, before the thread exists.
  const header = selected ? null : (
    <>
      <AgentPicker agents={agents} value={draftAgent} onChange={pickAgent} discovered={discovered} onAdd={addDiscoveredAgent} accounts={accounts} onAddAccount={addAccount} />
      <button className="context-btn" onClick={() => setShowDirPicker(true)} title={draftCwd}>
        <IconFolder size={14} />
        <span>{folderName(draftCwd) || '选择目录'}</span>
        <IconChevron size={12} open />
      </button>
      {offer && <WorkspacePicker branch={offer.branch} changes={offer.changes} worktree={draftWorktree} onChange={setDraftWorktree} />}
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

  const left = (
    <PermissionPicker
      modes={permissionModes}
      value={permission}
      canAsk={activeCaps?.approvals ?? true}
      openSignal={permissionSignal}
      onChange={(m) => (selected ? updateSelected({ permissionMode: m }) : setDraftPermission(m))}
    />
  );

  const right = (
    <>
      {selected && timeline.usage && <UsageMeter usage={timeline.usage} />}
      <ModelPicker
      models={models}
      model={model}
      efforts={effortLevels}
      effort={effort}
      openSignal={modelSignal}
      onModel={(v) => {
        if (selected) return updateSelected({ model: v }); // the daemon drops an effort the new model lacks
        setDraftModel(v);
        if (draftEffort && !effortsForModel(models, v, effortLevels).includes(draftEffort)) setDraftEffort(null);
      }}
      onEffort={(v) => (selected ? updateSelected({ effort: v }) : setDraftEffort(v))}
      />
    </>
  );

  return (
    <div className={`app${listOpen ? ' drawer-open' : ''}`}>
      {showDirPicker && (
        <DirectoryPicker
          api={api}
          roots={workdirs}
          selected={draftCwd}
          onSelect={setDraftCwd}
          onClose={() => setShowDirPicker(false)}
        />
      )}
      <aside className="sidebar">
        <Sidebar
          threads={threads}
          sections={sections}
          agents={agents}
          selectedId={selectedId}
          onSelect={pick}
          onNew={() => newThread()}
          onNewIn={newThread}
          compact={compact}
          onOpenSettings={(x, y) => setSettingsAt({ x, y })}
          onThreadMenu={threadActions.openThreadMenu}
          onSectionMenu={threadActions.openSectionMenu}
          onNewSection={threadActions.newSection}
          onOpenTodos={openTodos}
          todosActive={onTodos}
        />
      </aside>

      <main className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" aria-label="打开线程列表" aria-expanded={listOpen} onClick={() => setDrawer((v) => !v)}>
            <IconMenu />
          </button>
          <div className="topbar-heading">
            {/* The plan page carries its own heading. */}
            <div className="topbar-title">{onTodos ? '' : selected ? selected.title : '新线程'}</div>
            {selected && (
              <div className="topbar-sub" title={selected.cwd}>
                {agentLabel(selected.agent)} · {selected.worktree ? `${folderName(selected.worktree.of)} · ${selected.worktree.branch}` : folderName(selected.cwd)}
              </div>
            )}
          </div>
          {selected && (
            <div className="topbar-actions">
              {!compact && (
                <button className="icon-btn topbar-term" aria-label="打开终端" title="终端" onClick={() => setTermOpen(true)}>
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

        {error && (
          <div className="banner" role="alert">
            <span>{error}</span>
            <button className="icon-btn" aria-label="关闭提示" onClick={() => setError(null)}>
              ×
            </button>
          </div>
        )}

        {onTodos ? (
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
        ) : (
        <div key="thread" className="scroller" ref={scrollerRef} onScroll={onScroll} {...gestureProps}>
          {selected && <TurnRuler scrollerRef={scrollerRef} previews={turnPreviewMap} />}
          {selected && eventsLoading && <div className="loading-note">加载中…</div>}
          {selected ? (
            <ThreadView
              items={timeline.items}
              // While an approval is waiting, its card is the status; "working" would be wrong.
              running={running && !timeline.awaitingApproval}
              roots={threadRoots}
              loadImage={loadImage}
              loadFile={loadFile}
              onDecide={decide}
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
            />
          ) : (
            <div className="empty">
              <h2>我们应该在 {folderName(draftCwd) || '这里'} 中做些什么？</h2>
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

        {!onTodos && (
        <Composer
          draftKey={selectedId ?? 'new'}
          running={running}
          disabled={!selected && !draftCwd}
          placeholder={selected ? (running ? '追加一条，这一轮结束后发送' : '继续这个线程') : `在 ${folderName(draftCwd) || '工作目录'} 中开始`}
          onSend={send}
          onStop={stop}
          header={header}
          left={left}
          right={right}
          commands={commandsByKey[commandsKey] ?? []}
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
          quote={quoteSignal}
        />
        )}
        {/* With the list open, the conversation is a card pushed aside; a tap on it brings it back. */}
        <div className="scrim" onClick={() => setDrawer(false)} aria-hidden="true" />
      </main>

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
          onOpenQuota={activeCaps?.quota ? () => setQuotaAgent({ id: activeAgent, label: agentLabel(activeAgent) }) : undefined}
          onRunCommand={(text) => void send(text, []).catch(() => undefined)}
          onClose={() => setStatusOpen(false)}
        />
      )}
      {quotaAgent && api && (
        <QuotaPanel
          api={api}
          agentId={quotaAgent.id}
          agentLabel={quotaAgent.label}
          onClose={() => setQuotaAgent(null)}
          onError={handleError}
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
            performSend(p.text, p.images, false).then(p.resolve, p.reject);
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
            'separator',
            // Signing out costs the saved token, so it asks first.
            { id: 'sign-out', label: '退出', icon: IconSignOut, danger: true, onSelect: () => setConfirmSignOut(true) },
          ]}
        />
      )}
      {appearanceOpen && (
        <AppearancePanel appearance={appearance} theme={theme} onChange={setAppearance} onClose={() => setAppearanceOpen(false)} />
      )}
      {confirmSignOut && (
        <Dialog
          title="退出登录？"
          message="这台设备上保存的 token 会被清除，再进来要重新输入。"
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
      <SelectionMenu
        onQuote={(text) => setQuoteSignal({ text, nonce: Date.now() })}
        onSideAsk={(text) => setSideAsk({ text, nonce: Date.now() })}
      />
    </div>
  );
}
