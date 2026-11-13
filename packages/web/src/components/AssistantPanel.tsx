import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type AgentInfo, type Api, type PersonalSettings, type ProactiveAction, type ProactiveRun, type Thread, type Todo } from '../api';
import { historyPage, mergeHistory, mergeHistoryPage, watchHistory } from '../history';
import { replaceRun, startConflict, askingPins } from '../proactive';
import { buildDesk, briefStatus, type BriefStatus } from '../desk';
import { buildTimeline, type StoredEvent } from '../timeline';
import { restoreVideos } from '../videos';
import { useIsNarrow, useMinWidth } from '../hooks';
import { formatTime, t } from '../i18n';
import { ActionSheet, type SheetTarget } from './ActionSheet';
import { Composer } from './Composer';
import { ThreadView } from './ThreadView';
import { RunControls, RunSummary, type ProactiveState } from './ProactiveRuns';
import { DeskPage } from './DeskPage';
import { IconAgents, IconClock, IconClose, IconCompact, IconList, IconSettings, IconSideChat, IconSparkle } from './icons';

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
}

/** The assistant's home: the conversation itself, with everything else one drawer away. */
export function AssistantHome({ api, todos, loading, error, threads, threadsKnown, agents, personal, personalError, refreshKey, onReload, onPersonalChange, onPersonalRetry, onOpenThread, onOpenPlans, onConfigure, openFinds, onFindsOpened, onSpreadChange, revealTodoId, onRevealTodo, setupNeeded, onExplore, path, onPathChange, focusSignal }: Props) {
  const wide = useMinWidth(1200);
  const narrow = useIsNarrow();
  const agentLabel = useCallback((id: string) => agents.find(agent => agent.id === id)?.label ?? id, [agents]);

  // ——— Her thread: this page is it, never a copy ———
  const [threadId, setThreadId] = useState<string | null>(null);
  useEffect(() => {
    if (api.demo) return;
    let live = true;
    void api.petRouter().then(router => { if (live) setThreadId(router.threadId); }).catch(() => undefined);
    return () => { live = false; };
  }, [api, refreshKey]);

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
  const [thread, setThread] = useState<Thread | null>(null);
  const [threadError, setThreadError] = useState('');
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error_, setError] = useState('');
  const [cursor, setCursor] = useState<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const timeline = useMemo(() => buildTimeline(events), [events]);
  const waiting = useMemo(() => timeline.items.flatMap((item): SheetTarget[] =>
    item.kind === 'approval' && item.decision === null ? [{ kind: 'approval', item }]
      : item.kind === 'input' && item.answer === null ? [{ kind: item.inputKind === 'plan' ? 'plan-approval' : 'question', item }] : []), [timeline]);
  const running = timeline.running || thread?.status === 'running';

  useEffect(() => {
    if (!threadId) { setThread(null); setEvents([]); setLoaded(false); setCursor(null); return; }
    let live = true;
    setThreadError(''); setLoaded(false); setEvents([]); setCursor(null);
    const report = (e: unknown) => { if (live) setError(message(e)); };
    void api.thread(threadId).then(value => { if (live) setThread(value); }).catch(e => { if (live) setThreadError(message(e)); });
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    void watchHistory(api, threadId, ctrl.signal, {
      page: page => { setEvents(page.events); setCursor(page.hasOlder ? page.nextCursor : null); setLoaded(true); setError(''); },
      events: batch => {
        setEvents(previous => mergeHistory(previous, batch));
        if (batch.some(e => e.type.startsWith('turn.') || e.type === 'history.reset')) {
          clearTimeout(timer);
          timer = setTimeout(() => { if (!ctrl.signal.aborted) void api.thread(threadId).then(value => { if (live) setThread(value); }).catch(() => undefined); }, 200);
        }
      },
      error: report,
    });
    return () => { live = false; ctrl.abort(); clearTimeout(timer); };
  }, [api, threadId]);

  // Her asks stay in the conversation, as the last thing in it. The demo has none to ask.
  const [runs, setRuns] = useState<ProactiveRun[] | null>(null);
  const [runsError, setRunsError] = useState('');
  const [pending, setPending] = useState<Record<string, ProactiveAction>>({});
  const [failures, setFailures] = useState<Record<string, string>>({});
  const actionsAlive = useRef(true);
  useEffect(() => { actionsAlive.current = true; return () => { actionsAlive.current = false; }; }, []);
  const asks = useMemo(() => askingPins(runs), [runs]);
  const loadRuns = useCallback(() => {
    if (api.demo) { setRuns([]); return; }
    setRunsError('');
    void api.proactive().then(value => setRuns(value.runs)).catch(e => setRunsError(message(e)));
  }, [api]);
  useEffect(() => { loadRuns(); }, [loadRuns, refreshKey]);

  useEffect(() => { if (stick.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [events, asks.length]);

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
      if (event.isComposing || event.defaultPrevented) return;
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
  }, [drawer, overlay, openDrawer, focusComposer]);

  const loadImage = useCallback((id: string) => threadId ? api.attachment(threadId, id) : Promise.reject(new Error('no thread')), [api, threadId]);
  const loadFile = useCallback((path: string) => threadId ? api.threadFile(threadId, path) : Promise.reject(new Error('no thread')), [api, threadId]);
  const loadOlder = async () => {
    if (cursor === null || loadingOlder || !threadId) return;
    setLoadingOlder(true);
    const element = scroll.current;
    const height = element?.scrollHeight ?? 0;
    const top = element?.scrollTop ?? 0;
    try {
      const page = await historyPage(api, threadId, cursor);
      stick.current = false;
      setEvents(previous => mergeHistoryPage(previous, page));
      setCursor(page.hasOlder ? page.nextCursor : null);
      requestAnimationFrame(() => { if (element) element.scrollTop = top + element.scrollHeight - height; });
    } catch (e) { setError(message(e)); }
    finally { setLoadingOlder(false); }
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
  const state: ProactiveState = { runs, error: runsError, load: loadRuns, pending, failures, act };

  const send = async (text: string, images: { data: string; mimeType: string }[], videos: string[]) => {
    try {
      if (!threadId) {
        const started = await api.petSay(text);
        setThreadId(started.threadId);
        return;
      }
      await api.startTurn(threadId, text, images, { queue: true, videos });
      await api.thread(threadId).then(setThread).catch(() => undefined);
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
  const runningCount = sessions.filter(item => item.status === 'running').length;
  const errorCount = sessions.filter(item => item.status === 'error').length;
  // The brief's last word, quietly: while unknown the segment simply stays away, never a zero.
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
      } catch { /* The strip says nothing rather than guess. */ }
    })();
    return () => { live = false; };
  }, [api, refreshKey]);

  const askCards = <div className="chat-asks" aria-label={t('desk.chatPins')}>
    {needsSetup && <p className="chat-ask-error" role="alert">{t('pet.needsSetup')} <button className="ghost" onClick={onConfigure}>{t('desk.configure')}</button></p>}
    {runsError && <p className="chat-ask-error" role="alert">{runsError} <button className="ghost" onClick={loadRuns}>{t('common.retry')}</button></p>}
    {asks.map(run => run.kind === 'dispatch'
      ? <article key={run.id} className="chat-ask dispatch" data-run={run.id}>
          <span className="chat-ask-kind"><IconAgents size={13} />{t('desk.chatDispatch', run.agent ?? '')}</span>
          <p className="chat-ask-body">{run.task ?? run.summary ?? run.title ?? ''}</p>
          {run.cwd && <p className="chat-ask-cwd"><code>{run.cwd}</code></p>}
          <div className="chat-ask-acts">
            <button className="primary" disabled={Boolean(pending[run.id])} aria-busy={pending[run.id] === 'start'} onClick={() => act(run, 'start')}>{t('proactive.start')}</button>
            <button className="ghost" disabled={Boolean(pending[run.id])} onClick={() => act(run, 'dismiss')}>{t('proactive.noThanks')}</button>
          </div>
          {failures[run.id] && <p className="chat-ask-error" role="alert">{failures[run.id]}</p>}
        </article>
      : <article key={run.id} className="chat-ask" data-run={run.id}>
          <span className="chat-ask-kind personal-warning">{t(run.reason === 'done' ? 'proactive.looksDone' : 'proactive.status.asking')}</span>
          <RunSummary run={run} />
          <RunControls key={run.id} api={api} run={run} state={state} />
          {failures[run.id] && <p className="chat-ask-error" role="alert">{failures[run.id]}</p>}
        </article>)}
  </div>;

  const composer = <div className="chat-composer">
    <Composer attachBlocked={null} attachmentsBlocked={threadId ? undefined : t('desk.chatAttachFirst')} restore={null} note={null}
      draftKey={threadId ? `assistant-home:${threadId}` : 'assistant-home:new'} running={running} placeholder={t('desk.chatPlaceholder')}
      onSend={async (text, images, _mentions, videos = []) => {
        await send(text, images.map(({ data, mimeType }) => ({ data, mimeType })),
          await Promise.all(videos.map(async video => (await api.uploadVideo(threadId!, video.file)).id)));
      }}
      onStop={() => threadId && void api.cancel(threadId).catch(report)} onError={setError}
      header={null} left={null} right={null} commands={[]} actions={[]} hiddenCommands={[]} onAction={() => undefined}
      queued={thread?.queued ?? []}
      onRemoveQueued={id => threadId && void api.removeQueued(threadId, id).then(refresh).catch(report)}
      onEditQueued={async id => {
        const taken = await api.removeQueued(threadId!, id);
        return { ...taken, videos: await restoreVideos(api, threadId!, taken.videos) };
      }}
      onSendQueuedNow={id => threadId && void api.sendQueuedNow(threadId, id).then(refresh).catch(report)} />
  </div>;

  return <div className={`chat-home${drawer ? ' drawer-open' : ''}${drawer && wide ? ' side-by-side' : ''}`} ref={root}>
    <div className="chat-main" ref={mainRef}>
      <header className="chat-top">
        <span className="chat-brand"><span className="chat-ava"><IconSparkle size={15} /></span>{t('pet.name')}</span>
        <span className="sp"></span>
        <nav className="chat-entries" aria-label={t('desk.entries')}>
          <button className="chat-entry" onClick={() => openDrawer('matters')}><IconClock size={16} /><span className="chat-entry-label">{t('desk.entryNeed')}</span>{asks.length > 0 && <span className="chat-badge warn">{asks.length}</span>}</button>
          <button className="chat-entry" onClick={() => openDrawer('sessions')}><IconSideChat size={16} /><span className="chat-entry-label">{t('desk.entrySessions')}</span>{errorCount > 0 && <span className="chat-badge danger">{errorCount}</span>}</button>
          <button className="chat-entry" onClick={() => openDrawer('matters')}><IconList size={16} /><span className="chat-entry-label">{t('desk.entryMatters')}</span></button>
          <button className="chat-entry" onClick={() => openDrawer('desk')}><IconCompact size={16} /><span className="chat-entry-label">{t('desk.entryDesk')}</span></button>
          <button className="chat-entry" onClick={onConfigure}><IconSettings size={16} /><span className="chat-entry-label">{t('desk.entrySettings')}</span></button>
        </nav>
      </header>
      {/* The one line of globe kept on the home: quiet, clickable, never hiding a number. */}
      <div className="chat-strip" role="status">
        <button onClick={() => openDrawer('matters')}><span className={desk.needsYou > 0 ? 'warn' : undefined}>{t('desk.stripNeeds', loading || error ? null : desk.needsYou)}</span></button>
        {!narrow && <button onClick={() => openDrawer('sessions')}><span>{t('desk.stripRunning', threadsKnown ? runningCount : null)}</span></button>}
        <button onClick={() => openDrawer('sessions')}><span className={errorCount > 0 ? 'warn' : undefined}>{t('desk.stripError', threadsKnown ? errorCount : null)}</span></button>
        {brief && !narrow && <button onClick={onConfigure}><span className={brief.state === 'failed' ? 'warn' : undefined}>{t(`brief.kind.${brief.kind}`)} {t(brief.state === 'sent' ? 'brief.sent' : 'brief.failed', formatTime(brief.at, { hour: '2-digit', minute: '2-digit' }))}</span></button>}
      </div>

      {threadId || threadError ? <>
        <div className="chat-flow" ref={scroll} onScroll={() => { const el = scroll.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; }}>
          {threadError && <p className="chat-error" role="alert">{threadError} <button className="ghost" onClick={() => onOpenThread(threadId!)}>{t('threadPeek.open')}</button></p>}
          {!loaded && !threadError && <div className="loading-note">{t('common.loading')}</div>}
          {loaded && <ThreadView historyApi={api} historyThreadId={threadId!}
            items={timeline.items} roots={thread ? [thread.cwd, thread.cwdReal] : []} loadImage={loadImage} loadFile={loadFile}
            observeOlder={false} hasOlder={cursor !== null} loadingOlder={loadingOlder} onLoadOlder={() => void loadOlder()} />}
          {error_ && <p className="chat-error" role="alert">{error_}</p>}
          {askCards}
        </div>
        {composer}
      </> : <>
        <div className="chat-fresh">
          <span className="ava"><IconSparkle size={22} /></span>
          <h2>{t('desk.freshTitle')}</h2>
          <p>{t('desk.freshBody')}</p>
          <div className="chat-starters">
            <button className="chat-starter" onClick={() => void send(t('desk.starterPlan'), [], []).catch(report)}>{t('desk.starterPlan')}</button>
            <button className="chat-starter" onClick={() => void send(t('desk.starterWaiting'), [], []).catch(report)}>{t('desk.starterWaiting')}</button>
            <button className="chat-starter" onClick={() => void send(t('desk.starterDispatch'), [], []).catch(report)}>{t('desk.starterDispatch')}</button>
          </div>
          {error_ && <p className="chat-error" role="alert">{error_}</p>}
          {askCards}
        </div>
        {composer}
      </>}

      {waiting[0] && <ActionSheet key={waiting[0].item.key} target={waiting[0]} index={1} total={waiting.length}
        roots={thread ? [thread.cwd, thread.cwdReal] : []}
        onAnswer={async (id, answer) => { if (threadId) { await api.answerInput(id, answer); await api.thread(threadId).then(setThread).catch(() => undefined); } }}
        onDecide={async (id, option) => { if (threadId) await api.decide(id, option === null ? { cancel: true } : { optionId: option }); }}
        onRejectPlan={() => { if (threadId) onOpenThread(threadId); }} onSkipPlan={() => { if (threadId) onOpenThread(threadId); }} />}
    </div>

    {drawer && <aside className={`chat-drawer${wide ? ' side' : ' over'}`} ref={drawerRef} role="dialog" aria-modal={overlay || undefined} aria-label={t('desk.drawerLabel')}>
      <header className="chat-drawer-head">
        <b>{t(`desk.tab.${drawer === 'sessions' ? 'sessions' : drawer === 'matters' ? 'matters' : 'desk'}`)}</b>
        <span className="sp"></span>
        <button className="icon-btn" onClick={() => openDrawer(null)} title={t('common.close')} aria-label={t('common.close')}><IconClose size={17} /></button>
      </header>
      <nav className="chat-drawer-tabs">
        {(['desk', 'sessions', 'matters'] as const).map(tab => <button key={tab} aria-pressed={drawer === tab} onClick={() => { openDrawer(tab); }}>{t(`desk.tab.${tab}`)}</button>)}
      </nav>
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
