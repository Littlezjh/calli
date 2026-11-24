import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, type AgentInfo, type ModelOption, type Api, type PersonalSettings, type ProactiveAction, type ProactiveRun, type SuperagentTriageItem, type SuperagentTriageView, type Thread, type Todo } from '../api';
import { historyPage, mergeHistory, peekCachedPage, prependHistory, watchHistory } from '../history';
import { cachedRouterThreadId, rememberRouterThreadId } from '../history-cache';
import { useReadingPosition } from '../use-reading-position';
import { replaceRun, startConflict, askingPins, needTarget } from '../proactive';
import { buildDesk, briefStatus, type BriefStatus } from '../desk';
import { buildTimeline, type StoredEvent } from '../timeline';
import { restoreVideos } from '../videos';
import { useMinWidth } from '../hooks';
import { t } from '../i18n';
import { ActionSheet, type SheetTarget } from './ActionSheet';
import { Composer, type DraftNote } from './Composer';
import { ConversationSkeleton } from './ConversationSkeleton';
import { AgentPicker, ModelPicker, effortsForModel } from './Pickers';
import { ThreadView } from './ThreadView';
import { ThreadPeek } from './ThreadPeek';
import { DeskPage } from './DeskPage';
import { PlanView } from './PlanView';
import { IconAgents, IconChevron, IconClose, IconDrawer, IconSettings } from './icons';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

type DrawerTab = 'desk' | 'sessions' | 'matters';

interface Props {
  api: Api;
  todos: Todo[];
  loading: boolean;
  error: string;
  threads: Thread[];
  threadsKnown: boolean;
  agents: AgentInfo[];
  personal: PersonalSettings | null;
  personalError: string;
  refreshKey: number;
  onReload: () => void;
  onPersonalChange: (value: PersonalSettings) => void;
  onPersonalRetry: () => void;
  onOpenThread: (id: string) => void;
  onOpenPlans: () => void;
  onConfigure: () => void;
  openFinds?: boolean;
  onFindsOpened?: () => void;
  onSpreadChange?: (open: boolean) => void;
  revealTodoId?: string | null;
  onRevealTodo?: () => void;
  setupNeeded?: boolean | null;
  onExplore?: () => void;
  /** The drawer tab named by the address (#/desk/desk…), and where to write it back. */
  path: string;
  onPathChange: (path: string) => void;
  /** Bumped to move the caret into the composer: the pet's talk entry, from anywhere. */
  focusSignal: number;
  /** The app bar's slot for the entries; without one the home draws a bar of its own. */
  headerSlot?: HTMLElement | null;
  /** Leading sidebar controls shown when the left sidebar is hidden and the home draws its own top bar. */
  topLead?: ReactNode;
  /** Known router thread id from the parent app, if already resolved. */
  initialThreadId?: string | null;
  noteSignal?: { draftKey: string; note: DraftNote & { nonce: number } } | null;
  onNoteConsumed?: (id: string) => void;
  onNotesChange?: (draftKey: string, notes: DraftNote[]) => void;
  onOpenFile?: (path: string, threadId: string, draftKey: string) => Promise<void>;
}

/** The assistant's home: the conversation itself, with everything else one drawer away. */
export function AssistantHome({ api, todos, loading, error, threads, threadsKnown, agents, personal, personalError, refreshKey, onReload, onPersonalChange, onPersonalRetry, onOpenThread, onOpenPlans, onConfigure, openFinds, onFindsOpened, onSpreadChange, revealTodoId, onRevealTodo, setupNeeded, onExplore, path, onPathChange, focusSignal, headerSlot, topLead, initialThreadId, noteSignal, onNoteConsumed, onNotesChange, onOpenFile }: Props) {
  const wide = useMinWidth(1200);
  const agentLabel = useCallback((id: string) => agents.find(agent => agent.id === id)?.label ?? id, [agents]);

  // ——— Her thread: this page is it, never a copy ———
  const knownThreadId = api.demo ? null : (initialThreadId ?? cachedRouterThreadId(api.host));
  const [threadId, setThreadId] = useState<string | null>(() => knownThreadId);
  const [routerReady, setRouterReady] = useState<boolean>(() => api.demo || Boolean(knownThreadId));
  useEffect(() => {
    if (api.demo) { setThreadId(null); setRouterReady(true); return; }
    let live = true;
    const cached = initialThreadId ?? cachedRouterThreadId(api.host);
    if (cached) {
      setThreadId(current => current ?? cached);
      setRouterReady(true);
    } else {
      setRouterReady(false);
    }
    void api.petRouter()
      .then(router => {
        if (!live) return;
        rememberRouterThreadId(api.host, router.threadId);
        setThreadId(router.threadId);
        setRouterReady(true);
      })
      .catch(e => {
        if (!live) return;
        setRouterReady(true);
        if (!cached) setThreadError(message(e));
      });
    return () => { live = false; };
  }, [api, refreshKey, initialThreadId]);

  // ——— The drawer: closed until an entry names a tab; the desk mounts only once wanted ———
  const drawer: DrawerTab | null = path === 'desk' || path === 'sessions' || path === 'matters' ? path : null;
  const [revealTodo, setRevealTodo] = useState<string | null>(null);
  const openDrawer = useCallback((tab: DrawerTab | null) => onPathChange(tab ?? ''), [onPathChange]);
  useEffect(() => {
    if (openFinds || revealTodoId) openDrawer('desk');
  }, [openFinds, revealTodoId, openDrawer]);
  const drawerRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const overlay = drawer !== null && !wide;
  useEffect(() => {
    if (!overlay) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const main = mainRef.current;
    if (main) main.inert = true;
    drawerRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    return () => { if (main) main.inert = false; previous?.focus({ preventScroll: true }); };
  }, [overlay]);

  // ——— The conversation stream, as the peek reads it ———
  const initialPage = useMemo(() => (threadId ? peekCachedPage(api, threadId)?.page ?? null : null), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [thread, setThread] = useState<Thread | null>(() => (threadId ? threads.find(item => item.id === threadId) ?? null : null));
  const [threadError, setThreadError] = useState('');
  const [events, setEvents] = useState<StoredEvent[]>(() => initialPage?.events ?? []);
  const [loaded, setLoaded] = useState(() => Boolean(initialPage));
  const [error_, setError] = useState('');
  const [restore, setRestore] = useState<{ text: string; nonce: number } | null>(null);
  const [retryBusy, setRetryBusy] = useState(false);
  const [cursor, setCursor] = useState<number | null>(() => (initialPage?.hasOlder ? initialPage.nextCursor : null));
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState('');
  const [needsSetup, setNeedsSetup] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const activeThread = useRef(threadId);
  activeThread.current = threadId;
  const olderRequest = useRef<object | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const previewOrigin = useRef<{ focus: HTMLElement | null; top: number; offset: number } | null>(null);
  const previewOverlay = !useMinWidth(901);
  const openPreview = useCallback((id: string) => {
    const focus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    previewOrigin.current ??= { focus, top: scroll.current?.scrollTop ?? 0, offset: focus?.getBoundingClientRect().top ?? 0 };
    stick.current = false;
    openDrawer(null);
    setPreviewId(id);
  }, [openDrawer]);
  useLayoutEffect(() => {
    const origin = previewOrigin.current;
    if (!origin || !scroll.current) return;
    if (previewId) {
      if (origin.focus?.isConnected) scroll.current.scrollTop += origin.focus.getBoundingClientRect().top - origin.offset;
    } else {
      stick.current = false;
      scroll.current.scrollTop = origin.top;
      origin.focus?.focus({ preventScroll: true });
      previewOrigin.current = null;
    }
  }, [previewId]);
  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!previewId || !previewOverlay || !main) return;
    main.inert = true;
    return () => { main.inert = false; };
  }, [previewId, previewOverlay]);
  useEffect(() => { if (drawer) setPreviewId(null); }, [drawer]);
  const stick = useRef(true);
  const readingPosition = useReadingPosition(scroll, stick, threadId, events, '', Boolean(previewId));
  const timeline = useMemo(() => buildTimeline(events), [events]);
  const waiting = useMemo(() => timeline.items.flatMap((item): SheetTarget[] =>
    item.kind === 'approval' && item.decision === null ? [{ kind: 'approval', item }]
      : item.kind === 'input' && item.answer === null ? [{ kind: item.inputKind === 'plan' ? 'plan-approval' : 'question', item }] : []), [timeline]);
  const running = timeline.running || thread?.status === 'running';

  useEffect(() => {
    olderRequest.current = null;
    setLoadingOlder(false);
    setOlderError('');
    stick.current = true;
    if (!threadId) { setThread(null); setEvents([]); setLoaded(false); setCursor(null); return; }
    let live = true;
    const cached = peekCachedPage(api, threadId)?.page ?? null;
    setThreadError('');
    if (cached) {
      setEvents(cached.events);
      setCursor(cached.hasOlder ? cached.nextCursor : null);
      setLoaded(true);
    } else {
      setLoaded(false);
      setEvents([]);
      setCursor(null);
    }
    const report = (e: unknown) => { if (live) setError(message(e)); };
    void api.thread(threadId).then(value => { if (live) setThread(value); }).catch(e => { if (live) setThreadError(message(e)); });
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    void watchHistory(api, threadId, ctrl.signal, {
      pinned: true,
      page: page => { setEvents(page.events); setCursor(page.hasOlder ? page.nextCursor : null); setLoaded(true); setError(''); },
      events: batch => {
        setEvents(previous => mergeHistory(previous, batch));
        if (batch.some(e => e.type.startsWith('turn.') || e.type === 'history.reset' || e.type === 'thread.updated')) {
          clearTimeout(timer);
          timer = setTimeout(() => { if (!ctrl.signal.aborted) void api.thread(threadId).then(value => { if (live) setThread(value); }).catch(() => undefined); }, 200);
        }
      },
      error: report,
    });
    return () => { live = false; ctrl.abort(); clearTimeout(timer); };
  }, [api, threadId]);

  // Explicit dispatch proposals + SuperAgent's priority-filtered triage items (never raw background chatter).
  const [runs, setRuns] = useState<ProactiveRun[] | null>(null);
  const [runsError, setRunsError] = useState('');
  const [pending, setPending] = useState<Record<string, ProactiveAction>>({});
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [triage, setTriage] = useState<SuperagentTriageView>({ items: [], total: 0, overflowCount: 0 });
  const [shelving, setShelving] = useState<Record<string, boolean>>({});
  const actionsAlive = useRef(true);
  useEffect(() => { actionsAlive.current = true; return () => { actionsAlive.current = false; }; }, []);
  const dispatchAsks = useMemo(() => askingPins(runs).filter(run => run.kind === 'dispatch'), [runs]);
  const totalAsks = dispatchAsks.length + triage.total;
  const visibleAsks = dispatchAsks.length + triage.items.length;
  const loadRuns = useCallback(() => {
    if (api.demo) { setRuns([]); return; }
    setRunsError('');
    void api.proactive().then(value => setRuns(value.runs)).catch(e => setRunsError(message(e)));
  }, [api]);
  const loadTriage = useCallback(() => {
    if (api.demo) { setTriage({ items: [], total: 0, overflowCount: 0 }); return; }
    void api.superagentTriage().then(setTriage).catch(() => undefined);
  }, [api]);
  useEffect(() => { loadRuns(); }, [loadRuns, refreshKey]);
  useEffect(() => { loadTriage(); }, [loadTriage, refreshKey, todos, threads]);

  useEffect(() => { if (!previewId && stick.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [events, visibleAsks, previewId]);

  // The unread dot is the list's; reading here counts as reading.
  useEffect(() => {
    if (!thread?.unread || document.hidden) return;
    let live = true;
    void api.updateThread(thread.id, { unread: false }).then(() => { if (live) setThread(current => current ? { ...current, unread: false } : current); }).catch(() => undefined);
    return () => { live = false; };
  }, [api, thread?.id, thread?.unread]);

  const focusComposer = useCallback(() => {
    requestAnimationFrame(() => root.current?.querySelector<HTMLTextAreaElement>('.composer-box textarea')?.focus());
  }, []);
  useEffect(() => { if (focusSignal) focusComposer(); }, [focusSignal, focusComposer]);

  // '/' (or ⌘K) finds her composer from anywhere on this page; Esc puts the drawer away first.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented || previewId) return;
      const el = event.target;
      const typing = el instanceof Element && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el instanceof HTMLElement && el.isContentEditable) || el.closest('[role=dialog], [role=menu]'));
      const modal = [...document.querySelectorAll('[role=dialog][aria-modal=true]')].at(-1);
      if (document.querySelector('.pop-panel') || (modal && modal !== drawerRef.current)) return;
      if (event.key === 'Escape' && drawer !== null) { event.preventDefault(); openDrawer(null); return; }
      if (event.key === 'Tab' && overlay) {
        const items = [...(drawerRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea, a[href], [tabindex="0"]') ?? [])].filter(item => item.getClientRects().length);
        const first = items[0], last = items.at(-1);
        if (first && last && (!drawerRef.current?.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last))) {
          event.preventDefault(); (event.shiftKey ? last : first).focus();
        }
        return;
      }
      if (event.key !== '/' && !((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k')) return;
      if (typing) return;
      event.preventDefault();
      focusComposer();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer, overlay, openDrawer, focusComposer, previewId]);

  const loadImage = useCallback((id: string) => threadId ? api.attachment(threadId, id) : Promise.reject(new Error('no thread')), [api, threadId]);
  const loadFile = useCallback((path: string) => threadId ? api.threadFile(threadId, path) : Promise.reject(new Error('no thread')), [api, threadId]);
  const loadOlder = async () => {
    const id = threadId;
    if (cursor === null || loadingOlder || olderRequest.current || !id) return;
    const request = {};
    olderRequest.current = request;
    stick.current = false;
    setOlderError('');
    setLoadingOlder(true);
    try {
      const page = await historyPage(api, id, cursor);
      if (activeThread.current !== id || olderRequest.current !== request) return;
      stick.current = false;
      const firstTurn = page.events.find(event => event.type === 'turn.started') ?? page.events[0];
      readingPosition.preparePrepend(firstTurn?.seq);
      setEvents(previous => prependHistory(page.events, previous));
      setCursor(page.hasOlder ? page.nextCursor : null);
    } catch (e) {
      if (olderRequest.current === request) setOlderError(message(e));
    } finally {
      if (olderRequest.current === request) {
        olderRequest.current = null;
        setLoadingOlder(false);
      }
    }
  };

  const refresh = useCallback(() => {
    if (threadId) void api.thread(threadId).then(setThread).catch(() => undefined);
  }, [api, threadId]);
  const report = (e: unknown) => setError(message(e));

  // One decision at a time per run. A refused start carries the run as it stands: one that has
  // already begun jumps straight to its thread, one still on its way keeps its button busy.
  const act = (run: ProactiveRun, action: ProactiveAction, answer?: string) => {
    if (pending[run.id]) return;
    setPending(now => ({ ...now, [run.id]: action }));
    setFailures(({ [run.id]: _gone, ...rest }) => rest);
    void api.proactiveAct(run.id, action, answer)
      .then(next => {
        setRuns(now => now && replaceRun(now, next));
        if (action === 'start' && next.kind === 'dispatch' && next.threadId) onOpenThread(next.threadId);
        onReload();
      })
      .catch(async e => {
        const conflict = action === 'start' && e instanceof ApiError && e.status === 409 ? startConflict(e.details) : null;
        if (conflict === 'starting') {
          // Another client owns the start. Keep this decision busy until its result is visible;
          // a bounded read retry also recovers when the update notification was missed.
          for (let attempt = 0; attempt < 10 && actionsAlive.current; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 500));
            if (!actionsAlive.current) return;
            try {
              const next = (await api.proactive()).runs;
              if (!actionsAlive.current) return;
              setRuns(next);
              const current = next.find(item => item.id === run.id);
              if (current?.status === 'answered' && current.threadId) { onOpenThread(current.threadId); onReload(); return; }
              if (!current || current.status !== 'asking') return;
            } catch { break; }
          }
          if (!actionsAlive.current) return;
        }
        if (conflict && conflict !== 'starting') { setRuns(now => now && replaceRun(now, { ...run, status: 'answered', threadId: conflict.threadId })); onOpenThread(conflict.threadId); onReload(); return; }
        setFailures(now => ({ ...now, [run.id]: message(e) }));
        loadRuns();
      })
      .finally(() => setPending(({ [run.id]: _done, ...rest }) => rest));
  };

  const switchPromiseRef = useRef<Promise<string | null> | null>(null);
  const send = async (text: string, images: { data: string; mimeType: string }[], rawVideos: File[]) => {
    try {
      const targetId = switchPromiseRef.current ? await switchPromiseRef.current : threadId;
      if (!targetId) {
        const started = await api.petSay(text);
        rememberRouterThreadId(api.host, started.threadId);
        setThreadId(started.threadId);
        return;
      }
      const videos = rawVideos.length
        ? await Promise.all(rawVideos.map(async file => (await api.uploadVideo(targetId, file)).id))
        : [];
      await api.startTurn(targetId, text, images, { queue: true, videos });
      await api.thread(targetId).then(setThread).catch(() => undefined);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.message === 'personal agent is not configured') {
        setNeedsSetup(true);
        throw new Error(t('pet.needsSetup'));
      }
      throw e;
    }
  };

  // ——— The strip: what the globe is doing, without opening anything for it ———
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(timer); }, []);
  const desk = useMemo(() => buildDesk(todos, now), [todos, now]);
  const sessions = useMemo(() => threads.filter(item => !item.archivedAt && item.id !== threadId), [threads, threadId]);
  const errorCount = sessions.filter(item => item.status === 'error').length;
  const [brief, setBrief] = useState<BriefStatus | null>(null);
  useEffect(() => {
    if (api.demo) return;
    let live = true;
    void (async () => {
      try {
        const settings = await api.briefSettings();
        if (!settings.enabled) { if (live) setBrief(null); return; }
        const [morning, evening, push] = await Promise.all([api.lastPersonalBrief('morning'), api.lastPersonalBrief('evening'), api.pushStatus(true)]);
        if (live) setBrief(briefStatus({ morning, evening }, push.records, new Date()));
      } catch { /* Quiet when unknown. */ }
    })();
    return () => { live = false; };
  }, [api, refreshKey]);

  // Pending asks stay tucked into a quiet right-edge thumb chip above the composer until tapped,
  // showing only fresh dispatch proposals and SuperAgent's top-5 high-signal decisions.
  const [trayOpen, setTrayOpen] = useState(false);
  const [openAsk, setOpenAsk] = useState<string | null>(null);
  useEffect(() => { if (visibleAsks === 0) setTrayOpen(false); }, [visibleAsks]);
  useEffect(() => {
    if (!trayOpen) return;
    const onEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing && !event.defaultPrevented && !document.querySelector('.pop-panel, [role=menu], [role=dialog][aria-modal=true]')) {
        event.preventDefault();
        setTrayOpen(false);
      }
    };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [trayOpen]);
  const singleDispatch = dispatchAsks.length === 1 && triage.items.length === 0;
  const shownAsk = singleDispatch ? dispatchAsks[0].id : openAsk && dispatchAsks.some(run => run.id === openAsk) ? openAsk : null;
  const shelveTriageItem = (item: SuperagentTriageItem) => {
    if (shelving[item.id]) return;
    setShelving(now => ({ ...now, [item.id]: true }));
    setTriage(prev => {
      const items = prev.items.filter(candidate => candidate.id !== item.id);
      const total = Math.max(0, prev.total - 1);
      return { items, total, overflowCount: Math.max(0, total - 5) };
    });
    void api.shelveSuperagentTriage(item.id)
      .then(() => { loadTriage(); loadRuns(); })
      .catch(e => { setError(message(e)); loadTriage(); })
      .finally(() => setShelving(({ [item.id]: _done, ...rest }) => rest));
  };
  const openNeed = (id: string) => {
    const target = needTarget(id, runs);
    if (target.kind === 'thread') { void api.recordThreadOpen(target.id, 'assistant-link').catch(() => undefined); onOpenThread(target.id); return; }
    if (target.kind === 'ask') {
      if (target.run.kind === 'dispatch') { openDrawer(null); setTrayOpen(true); setOpenAsk(target.run.id); return; }
      if (target.run.threadId) { void api.recordThreadOpen(target.run.threadId, 'assistant-link').catch(() => undefined); onOpenThread(target.run.threadId); return; }
    }
    loadRuns(); loadTriage(); onReload();
  };
  const askCards = (needsSetup || runsError || visibleAsks > 0) ? <div className="chat-asks" aria-label={t('desk.chatPins')}>
    {needsSetup && <p className="chat-ask-error" role="alert">{t('pet.needsSetup')} <button className="ghost" onClick={onConfigure}>{t('desk.configure')}</button></p>}
    {runsError && <p className="chat-ask-error" role="alert">{runsError} <button className="ghost" onClick={loadRuns}>{t('common.retry')}</button></p>}
    {visibleAsks > 0 && <>
      {trayOpen && <section className="chat-tray open">
        <ul className="chat-tray-list">
          {dispatchAsks.map(run => {
            const open = shownAsk === run.id;
            const line = (run.title || run.task || run.summary || '').split('\n').map(s => s.trim()).find(Boolean) ?? '';
            return <li key={run.id} className={`chat-ask dispatch${open ? ' open' : ''}`} data-run={run.id}>
              <button className="chat-ask-row" aria-expanded={open} aria-controls={`ask-${run.id}`} disabled={singleDispatch} onClick={() => setOpenAsk(open ? null : run.id)}>
                <span className="chat-ask-kind"><IconAgents size={13} />{t('desk.chatDispatch', run.agent ?? '')}</span>
                <span className="chat-ask-line">{line}</span>
              </button>
              {open && <div className="chat-ask-detail" id={`ask-${run.id}`}>
                <p className="chat-ask-body">{run.task ?? run.summary ?? run.title ?? ''}</p>
                {run.cwd && <p className="chat-ask-cwd"><code>{run.cwd}</code></p>}
                <div className="chat-ask-acts">
                  <button className="primary" disabled={Boolean(pending[run.id])} aria-busy={pending[run.id] === 'start'} onClick={() => act(run, 'start')}>{t('proactive.start')}</button>
                  <button className="ghost" disabled={Boolean(pending[run.id])} onClick={() => act(run, 'dismiss')}>{t('proactive.noThanks')}</button>
                </div>
              </div>}
              {failures[run.id] && <p className="chat-ask-error" role="alert">{failures[run.id]}</p>}
            </li>;
          })}
          {triage.items.map(item => <li key={item.id} className="chat-ask triage" data-triage={item.id}>
            <div className="chat-triage-item">
              <button type="button" className="chat-ask-row triage-main" onClick={() => {
                setTrayOpen(false);
                if (item.threadId) {
                  void api.recordThreadOpen(item.threadId, 'assistant-link').catch(() => undefined);
                  openPreview(item.threadId);
                } else {
                  setRevealTodo(item.id);
                  openDrawer('desk');
                }
              }}>
                <span className="chat-triage-head">
                  {item.kind !== 'needs_user' && <span className={`chat-ask-kind${item.kind === 'approval' ? ' personal-warning' : ''}`}>{t(item.kind === 'approval' ? 'desk.triageApproval' : 'desk.triageReview')}</span>}
                  <span className="chat-triage-title">{item.title}</span>
                </span>
                <span className="chat-triage-sub">{item.summary}</span>
              </button>
              <button type="button" className="chat-triage-shelve" disabled={Boolean(shelving[item.id])}
                aria-label={t('desk.shelveAsk', item.title)} title={t('desk.shelve')}
                onClick={() => shelveTriageItem(item)}>
                <IconClose size={14} />
              </button>
            </div>
          </li>)}
          {triage.overflowCount > 0 && <li className="chat-ask more">
            <button type="button" className="chat-triage-more" onClick={() => { setTrayOpen(false); openDrawer('matters'); }}>
              <span>{t('desk.triageMore', triage.overflowCount)}</span>
              <IconChevron size={12} />
            </button>
          </li>}
        </ul>
      </section>}
      <div className="chat-ask-orb-row">
        <button className="chat-ask-orb" aria-expanded={trayOpen} onClick={() => setTrayOpen(open => !open)}>
          <span className="chat-ask-dot" aria-hidden="true" />
          <span>{t('desk.asksOrb', totalAsks)}</span>
          <IconChevron size={13} open={trayOpen} />
        </button>
      </div>
    </>}
  </div> : null;

  // Two independent quiet circles at top-right: workbench drawer + settings (no screaming numeric badges).
  const needsCount = loading || error ? null : desk.needsYou + dispatchAsks.filter(run => !run.matterId).length + triage.total;
  const lastDrawerTab = useRef<DrawerTab | null>(null);
  if (drawer) lastDrawerTab.current = drawer;
  const toggleWorkbench = () => {
    if (drawer) { openDrawer(null); return; }
    openDrawer(lastDrawerTab.current ?? ((needsCount ?? 0) > 0 ? 'matters' : 'desk'));
  };
  const header = <nav className="chat-entries" aria-label={t('desk.entries')}>
    <button className="chat-entry" aria-expanded={drawer !== null} onClick={toggleWorkbench} title={t('desk.entryWorkbench')}>
      <IconDrawer size={17} />
      <span className="chat-entry-label">{t('desk.entryWorkbench')}</span>
      {(threadsKnown && errorCount > 0) || brief?.state === 'failed' ? <span className="chat-entry-dot" aria-hidden="true" /> : null}
    </button>
    <button className="chat-entry" onClick={onConfigure} title={t('desk.entrySettings')}>
      <IconSettings size={17} />
      <span className="chat-entry-label">{t('desk.entrySettings')}</span>
    </button>
  </nav>;

  // Who she is and which model she thinks with, picked right here as a thread's composer does.
  // Switching updates immediately without locking the composer: handover context is prepared in the
  // background and full earlier history is pulled on demand, so typing can continue at once.
  const [handingTo, setHandingTo] = useState<string | null>(null);
  const activeAgent = handingTo ?? thread?.agent ?? personal?.agent ?? null;
  const caps = activeAgent ? agents.find(agent => agent.id === activeAgent)?.capabilities : undefined;
  const [models, setModels] = useState<ModelOption[]>([]);
  const loadModels = useCallback((refresh = false) => {
    if (!activeAgent) return;
    void api.models(activeAgent, refresh).then(setModels).catch(() => undefined);
  }, [api, activeAgent]);
  useEffect(() => { setModels([]); loadModels(); }, [loadModels]);
  const switchAgent = (agent: string) => {
    const currentAgent = handingTo ?? thread?.agent ?? personal?.agent;
    if (!currentAgent || agent === currentAgent) return;
    setHandingTo(agent);
    setError('');
    const promise = api.switchPersonalAgent(agent)
      .then(result => {
        onPersonalChange(result.settings);
        if (result.threadId) {
          rememberRouterThreadId(api.host, result.threadId);
          setThreadId(result.threadId);
        }
        return result.threadId;
      })
      .catch(e => {
        setError(message(e));
        throw e;
      })
      .finally(() => {
        if (switchPromiseRef.current === promise) switchPromiseRef.current = null;
        setHandingTo(current => current === agent ? null : current);
      });
    switchPromiseRef.current = promise;
  };
  const updateModel = (patch: { model?: string | null; effort?: string | null }) => {
    if (!thread) return;
    const before = thread;
    setThread({ ...thread, ...patch });
    void api.updateThread(thread.id, { ...patch, rememberModelChoice: true }).then(setThread).catch(e => { setThread(before); report(e); });
    // Her setting follows the thread's model, or her next message would start a new conversation.
    if (patch.model !== undefined && personal) void api.savePersonalSettings({ ...personal, model: patch.model }).then(onPersonalChange).catch(report);
  };
  const composerLeft = activeAgent ? <span className="chat-agent-pick">
    <AgentPicker api={api} agents={agents} value={activeAgent} onChange={switchAgent} />
  </span> : null;
  const composerRight = thread && !handingTo && caps ? <ModelPicker catalog={caps.modelCatalog} models={models} model={thread.model ?? null}
    efforts={caps.effortLevels ?? []} effort={thread.effort ?? null} onOpen={() => loadModels(true)}
    onModel={model => updateModel({ model, effort: thread.effort && effortsForModel(models, model, caps.effortLevels ?? []).includes(thread.effort) ? thread.effort : null })}
    onEffort={effort => updateModel({ effort })} /> : null;

  const onNotesChangeRef = useRef(onNotesChange);
  onNotesChangeRef.current = onNotesChange;
  const handleAssistantNotes = useCallback((notes: DraftNote[]) => { onNotesChangeRef.current?.('assistant-home', notes); }, []);
  useEffect(() => () => { onNotesChangeRef.current?.('assistant-home', []); }, []);

  const composer = <div className="chat-composer">
    {askCards}
    <Composer attachBlocked={null} attachmentsBlocked={threadId ? undefined : t('desk.chatAttachFirst')} restore={restore}
      note={noteSignal?.draftKey === 'assistant-home' ? noteSignal.note : null}
      onNoteConsumed={onNoteConsumed}
      onNotesChange={onNotesChange ? handleAssistantNotes : undefined}
      draftKey="assistant-home" running={running && !handingTo} placeholder={t('desk.chatPlaceholder')}
      onSend={async (text, images, _mentions, videos = []) => {
        await send(text, images.map(({ data, mimeType }) => ({ data, mimeType })), videos.map(video => video.file));
      }}
      onStop={() => threadId && void api.cancel(threadId).then(result => { if (result.dropped.length) setRestore({ text: result.dropped.join('\n\n'), nonce: Date.now() }); refresh(); }).catch(report)} onError={setError}
      header={null} left={composerLeft} right={composerRight} commands={[]} actions={[]} hiddenCommands={[]} onAction={() => undefined}
      queued={thread?.queued ?? []}
      onRemoveQueued={id => threadId && void api.removeQueued(threadId, id).then(refresh).catch(report)}
      onEditQueued={async id => {
        const taken = await api.removeQueued(threadId!, id);
        return { ...taken, videos: await restoreVideos(api, threadId!, taken.videos) };
      }}
      onSendQueuedNow={id => threadId && void api.sendQueuedNow(threadId, id).then(refresh).catch(report)} />
  </div>;

  const sideBySide = Boolean((drawer && wide) || (previewId && !previewOverlay));
  const openAssistantFile = useCallback(async (filePath: string) => {
    if (!onOpenFile || !threadId) return;
    await onOpenFile(filePath, threadId, 'assistant-home');
    openDrawer(null);
    setPreviewId(null);
  }, [onOpenFile, threadId, openDrawer]);
  const openPeekFile = useCallback(async (filePath: string, targetId: string) => {
    if (!onOpenFile) return;
    await onOpenFile(filePath, targetId, 'assistant-home');
    setPreviewId(null);
  }, [onOpenFile]);

  return <div className={`chat-home${drawer ? ' drawer-open' : ''}${sideBySide ? ' side-by-side' : ''}`} ref={root}>
    <div className="chat-main" ref={mainRef}>
      {headerSlot && !sideBySide ? createPortal(header, headerSlot) : <header className="chat-top">{topLead}<span className="chat-brand">{t('desk.title')}</span><span className="sp" />{header}</header>}

      {threadId || threadError || !routerReady ? <>
        <div className="chat-flow" ref={scroll} tabIndex={0} data-note-target="assistant-home" data-note-thread={threadId ?? ''} onScroll={() => {
          const el = scroll.current;
          if (!el || readingPosition.didRestore()) return;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          readingPosition.capture();
        }}>
          <div className="chat-reading">
            {threadError && <p className="chat-error" role="alert">{threadError} {threadId && <button className="ghost" onClick={() => onOpenThread(threadId)}>{t('threadPeek.open')}</button>}</p>}
            {(!routerReady || (!loaded && !threadError)) && <ConversationSkeleton />}
            {/* After an agent switch the earlier talk is one tap away, at the top where it would have been. */}
            {loaded && cursor === null && thread?.handover?.sourceId && <button className="chat-earlier" onClick={() => onOpenThread(thread.handover!.sourceId)}>{t('desk.earlierWith', agentLabel(thread.handover.agent))}</button>}
            {loaded && threadId && <ThreadView historyApi={api} historyThreadId={threadId} historyTitle={thread?.title}
              threads={threads} onOpenThread={openPreview}
              items={timeline.items} roots={thread ? [thread.cwd, thread.cwdReal] : []} loadImage={loadImage} loadFile={loadFile}
              onOpenFile={onOpenFile && threadId ? openAssistantFile : undefined}
              autoRetry={!api.demo && thread?.autoRetry ? {
                ...thread.autoRetry, busy: retryBusy,
                onCancel: () => {
                  setRetryBusy(true);
                  void api.cancelAutoRetry(thread.id).then(value => setThread(current => current?.id === value.id ? value : current))
                    .catch(e => setError(message(e))).finally(() => setRetryBusy(false));
                },
              } : null}
              hasOlder={cursor !== null} loadingOlder={loadingOlder} olderError={olderError || undefined} onLoadOlder={() => void loadOlder()} />}
            {error_ && <p className="chat-error" role="alert">{error_}</p>}
          </div>
        </div>
        {composer}
      </> : <>
        <div className="chat-fresh">
          <h2>{t('desk.freshTitle')}</h2>
          <p>{t('desk.freshBody')}</p>
          <div className="chat-starters">
            <button className="chat-starter" onClick={() => void send(t('desk.starterUrgent'), [], []).catch(report)}>{t('desk.starterUrgent')}</button>
            <button className="chat-starter" onClick={() => void send(t('desk.starterPlan'), [], []).catch(report)}>{t('desk.starterPlan')}</button>
            <button className="chat-starter" onClick={() => void send(t('desk.starterWaiting'), [], []).catch(report)}>{t('desk.starterWaiting')}</button>
          </div>
          {error_ && <p className="chat-error" role="alert">{error_}</p>}
        </div>
        {composer}
      </>}

      {waiting[0] && <ActionSheet key={waiting[0].item.key} target={waiting[0]} index={1} total={waiting.length}
        roots={thread ? [thread.cwd, thread.cwdReal] : []}
        onAnswer={async (id, answer) => { if (threadId) { await api.answerInput(id, answer); await api.thread(threadId).then(setThread).catch(() => undefined); } }}
        onDecide={async (id, option) => { if (threadId) await api.decide(id, option === null ? { cancel: true } : { optionId: option }); }}
        onRejectPlan={() => { if (threadId) onOpenThread(threadId); }} onSkipPlan={() => { if (threadId) onOpenThread(threadId); }} />}
    </div>

    {previewId && <ThreadPeek key={previewId} side api={api} initial={previewId} agents={agents}
      draftKey={previewId} returnFocus={null} onClose={() => setPreviewId(null)}
      onOpen={() => onOpenThread(previewId)} onChange={onReload}
      noteSignal={noteSignal} onNoteConsumed={onNoteConsumed} onNotesChange={onNotesChange}
      onOpenFile={onOpenFile ? openPeekFile : undefined} />}
    {drawer && <aside className={`chat-drawer${wide ? ' side' : ' over'}`} ref={drawerRef} role="dialog" aria-modal={overlay || undefined} aria-label={t('desk.drawerLabel')}>
      <header className="chat-drawer-head">
        <nav className="chat-drawer-tabs">
          {(['desk', 'sessions', 'matters'] as const).map(tab => <button key={tab} aria-pressed={drawer === tab} onClick={() => { openDrawer(tab); }}>{t(`desk.tab.${tab}`)}</button>)}
        </nav>
        <span className="sp"></span>
        <button className="icon-btn" onClick={() => openDrawer(null)} title={t('common.close')} aria-label={t('common.close')}><IconClose size={17} /></button>
      </header>
      <div className="chat-drawer-body">
        {drawer === 'desk' && <DeskPage api={api} todos={todos} loading={loading} error={error} threads={threads} agents={agents}
          personal={personal} personalError={personalError} refreshKey={refreshKey} onReload={onReload}
          onPersonalChange={onPersonalChange} onPersonalRetry={onPersonalRetry} onOpenThread={onOpenThread} onOpenPlans={onOpenPlans}
          openFinds={openFinds} onFindsOpened={onFindsOpened} onSpreadChange={onSpreadChange}
          revealTodoId={revealTodoId ?? revealTodo} onRevealTodo={() => { setRevealTodo(null); onRevealTodo?.(); }}
          setupNeeded={setupNeeded} onExplore={onExplore}
          onChat={() => { openDrawer(null); focusComposer(); }} />}
        {drawer === 'sessions' && <ul className="chat-sessions">
          {sessions.map(item => <li key={item.id}><button onClick={() => onOpenThread(item.id)}>
            <span className="chat-session-title">{item.title || agentLabel(item.agent)}</span>
            <span className="chat-session-meta">
              <span className={item.status === 'error' ? 'err' : item.status === 'running' ? 'run' : undefined}>{t(`status.${item.status}`)}</span>
              <span>{agentLabel(item.agent)}{item.unread ? ` · ${t('desk.sessionUnread')}` : ''}</span>
            </span>
            {item.preview && <span className="chat-session-line">{item.preview}</span>}
          </button></li>)}
          {!sessions.length && <li className="chat-drawer-empty">{t('desk.sessionsEmpty')}</li>}
        </ul>}
        {drawer === 'matters' && <PlanView api={api} refreshKey={refreshKey} onOpenThread={openNeed} onOpenTodo={id => { setRevealTodo(id); openDrawer('desk'); }} />}
        {drawer === 'matters' && <h4 className="chat-drawer-sub">{t('horizon.allMatters')}</h4>}
        {drawer === 'matters' && <ul className="chat-sessions">
          {(todos.filter(todo => !todo.done)).map(todo => <li key={todo.id}><button onClick={() => { setRevealTodo(todo.id); openDrawer('desk'); }}>
            <span className="chat-session-title">{todo.text}</span>
            <span className="chat-session-meta">{todo.stage === 'answer' && <span className="warn">{t('proactive.status.asking')}</span>}</span>
          </button></li>)}
          {!todos.some(todo => !todo.done) && <li className="chat-drawer-empty">{t('desk.mattersEmpty')}</li>}
        </ul>}
      </div>
    </aside>}
    {drawer && !wide && <div className="chat-drawer-scrim" onClick={() => openDrawer(null)} />}
  </div>;
}
