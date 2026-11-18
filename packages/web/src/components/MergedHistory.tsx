import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { ApiError, type Api, type Thread } from '../api';
import { historyPage, prependHistory, type HistoryPage } from '../history';
import { buildTimeline, clockLabel } from '../timeline';
import { t } from '../i18n';
import { entryKey, type ChainEntry } from '../handover';
import { AgentMark, IconArrowDown, IconChevron, IconHandover } from './icons';
import { Prose, ThreadView } from './ThreadView';

type ViewProps = ComponentProps<typeof ThreadView>;
type Part = 'before' | 'after' | undefined;
type Segment = { thread: Thread; page: HistoryPage; part?: 'before' | 'after'; clip?: number; followups: number };
/** The segment the reading is at: its id and part, and whether its own line has scrolled out of sight. */
export interface ChainFocus { threadId: string; part?: 'before' | 'after'; lineHidden: boolean }
type Props = ViewProps & {
  api: Api; thread: Thread; merged: boolean; ready: boolean;
  agentLabel: (id: string) => string;
  onBrowseOlder: () => void;
  onSegmentFork: (thread: Thread, turn: string) => void;
  canFork: (thread: Thread) => { enabled: boolean; any: boolean };
  onSegmentFile: (thread: Thread, path: string) => Promise<void>;
  onSegmentPreview: (thread: Thread, path: string) => void;
  /** What follows a segment: the next of an automatic chain, or a conversation handed over to by hand; none at the end. Reading goes on into it. */
  laterOf?: (entry: { thread: Thread; part?: 'before' | 'after' }) => ChainEntry | undefined;
  /** The chain's latest segment: the line's arrow goes back to it, and the one that needs no marker. */
  latest?: Thread;
  agentIcon?: (id: string) => string | undefined;
  /** The title on a segment's line: open that segment alone, to go on in. */
  onOpenSegment?: (thread: Thread, alone?: boolean) => void;
  onGoLatest?: () => void;
  /** Which segment the reading is at, as the person scrolls: where a typed message goes. */
  onFocus?: (focus: ChainFocus | null) => void;
};

/** Every relay, automatic or by hand, leaves a fold at its start with what the successor was given. */
const handedOver = (thread: Thread): boolean => Boolean(thread.handover && !thread.handover.detached);

/** The segment before this one in the chain: the thread that handed over, or the one the chain came back from. */
function olderOf(entry: { thread: Thread; part?: 'before' | 'after' }): { id: string; clip?: number; followups: number; viaHandback: boolean } | null {
  const { thread } = entry;
  if (thread.handback && entry.part !== 'before') return { id: thread.handback.sourceId, clip: thread.handback.sourceSeq + 1, followups: 0, viaHandback: true };
  const link = thread.handover;
  if (link && !link.detached) return { id: link.sourceId, ...(link.sourceSeq !== undefined ? { clip: link.sourceSeq + 1 } : {}), followups: link.followups ?? 0, viaHandback: false };
  return null;
}

/** Each earlier segment owns its client, cursor and action targets. No ancestor reads on mount. */
export function MergedHistory({ api, thread, merged, ready, agentLabel, laterOf, latest, agentIcon, onOpenSegment, onGoLatest, onFocus, onBrowseOlder, onSegmentFork, canFork, onSegmentFile, onSegmentPreview, ...current }: Props) {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<'missing' | 'failed' | null>(null);
  const [later, setLater] = useState<Segment[]>([]);
  const [loadingLater, setLoadingLater] = useState(false);
  const [laterFailed, setLaterFailed] = useState(false);
  const [focus, setFocus] = useState<ChainFocus | null>(null);
  const pendingLater = useRef(false);
  const laterGeneration = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);
  const pending = useRef(false);
  const generation = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const restore = useRef<number | null>(null);
  // A thread the chain came back to is read from its part after the return; the part before it is a segment further up.
  const currentPart: Part = thread.handback ? 'after' : undefined;
  useEffect(() => {
    generation.current++; pending.current = false;
    setSegments([]); setLoading(false); setError(null);
  }, [api, thread.id, merged]);
  useLayoutEffect(() => {
    const scroller = root.current?.closest<HTMLElement>('.scroller');
    if (scroller && restore.current !== null) scroller.scrollTop = scroller.scrollHeight - restore.current;
    restore.current = null;
  }, [segments]);
  const load = async () => {
    if (pending.current || !ready) return;
    if (!segments.length && current.hasOlder) { onBrowseOlder(); current.onLoadOlder?.(); return; }
    const oldest = segments[0];
    const same = Boolean(oldest?.page.hasOlder);
    const from = oldest ?? { thread, part: currentPart };
    const next = same ? null : olderOf(from);
    if (!same && !next) return;
    const seen = new Set([entryKey({ thread, part: currentPart }), ...segments.map(entryKey)]);
    pending.current = true; setLoading(true); setError(null); onBrowseOlder();
    const version = generation.current;
    try {
      const target = same ? oldest.thread : await api.thread(next!.id);
      // The part of a thread the chain came back to that was read before it handed over.
      const part: Part = same ? oldest.part : next!.viaHandback ? undefined : target.handback ? 'before' : undefined;
      const entry = { thread: target, part: part ?? (target.handback ? 'after' as const : undefined) };
      // Broken/cyclic metadata must not repeatedly insert the same conversation.
      if (!same && seen.has(entryKey(entry))) { if (generation.current === version) setError('missing'); return; }
      const clip = same ? oldest.clip : next!.clip;
      const cursor = same ? oldest.page.nextCursor ?? undefined : clip;
      const page = part === 'before' ? await api.historyPage(target.id, cursor, undefined, true, undefined, false, 'before') : await historyPage(api, target.id, cursor, undefined, true);
      if (generation.current !== version) return;
      const scroller = root.current?.closest<HTMLElement>('.scroller');
      if (scroller) restore.current = scroller.scrollHeight - scroller.scrollTop;
      setSegments(previous => same
        ? [{ ...previous[0], thread: target, page: { ...page, events: prependHistory(page.events, previous[0].page.events) } }, ...previous.slice(1)]
        : [{ thread: target, page, ...(part ? { part } : {}), ...(clip !== undefined ? { clip } : {}), followups: next!.followups }, ...previous]);
    } catch (e) {
      if (generation.current === version) setError(e instanceof ApiError && e.status === 404 ? 'missing' : 'failed');
    } finally {
      if (generation.current === version) { pending.current = false; setLoading(false); }
    }
  };
  // Reading on from a segment: the next one is read from its beginning, a page at a time, as the end
  // of this one comes into view, so the chain scrolls like one conversation. What follows is known
  // from the list of threads, so when it changes (the source went on after a handover by hand) what
  // was loaded below is dropped.
  const first = laterOf?.({ thread, part: currentPart });
  const firstKey = first ? entryKey(first) : null;
  useEffect(() => {
    laterGeneration.current++; pendingLater.current = false;
    setLater([]); setLoadingLater(false); setLaterFailed(false);
  }, [api, thread.id, firstKey]);
  const tail = later.at(-1);
  const shown = new Set([entryKey({ thread, part: currentPart }), ...segments.map(entryKey), ...later.map(entryKey)]);
  const candidate = tail ? laterOf?.(tail) : first;
  // A broken or cyclic relation must not insert the same conversation twice.
  const nextEntryToLoad = candidate && !shown.has(entryKey(candidate)) ? candidate : undefined;
  const hasLater = Boolean(tail?.page.hasNewer || nextEntryToLoad);
  const loadLater = async () => {
    if (pendingLater.current || !ready) return;
    const same = Boolean(tail?.page.hasNewer);
    const target = same ? tail! : nextEntryToLoad;
    if (!target) return;
    pendingLater.current = true; setLoadingLater(true); setLaterFailed(false); onBrowseOlder();
    const version = laterGeneration.current;
    try {
      const part = target.part === 'before' ? 'before' as const : undefined;
      const page = await api.historyPage(target.thread.id, target.clip, same ? tail!.page.nextCursor ?? undefined : undefined, true, undefined, true, part);
      if (laterGeneration.current !== version) return;
      setLater(previous => same
        ? [...previous.slice(0, -1), { ...tail!, page: { ...page, events: prependHistory(tail!.page.events, page.events) } }]
        : [...previous, { thread: target.thread, page, ...(target.part ? { part: target.part } : {}), ...(target.clip !== undefined ? { clip: target.clip } : {}), followups: target.followups }]);
    } catch { if (laterGeneration.current === version) setLaterFailed(true); }
    finally { if (laterGeneration.current === version) { pendingLater.current = false; setLoadingLater(false); } }
  };
  const loader = useRef(loadLater);
  loader.current = loadLater;
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasLater || !ready || loadingLater || laterFailed) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void loader.current(); },
      { root: root.current?.closest<HTMLElement>('.scroller') ?? null, rootMargin: '0px 0px 600px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasLater, ready, loadingLater, laterFailed, later]);
  // Which segment the reading is at: the last whose top is above a line a third of the way down. Its
  // own line is "hidden" once it has scrolled past the top; the floating line then stands in for it.
  const report = useRef(onFocus);
  report.current = onFocus;
  useEffect(() => {
    const scroller = root.current?.closest<HTMLElement>('.scroller');
    if (!merged || !scroller) { setFocus(null); report.current?.(null); return; }
    let frame = 0;
    const measure = () => {
      frame = 0;
      const box = scroller.getBoundingClientRect();
      const line = box.top + Math.min(160, box.height / 3);
      let found: ChainFocus | null = null;
      for (const node of root.current?.querySelectorAll<HTMLElement>('[data-history-thread]') ?? []) {
        if (node.getBoundingClientRect().top > line) break;
        const id = node.dataset.historyThread!;
        const part = node.dataset.historyPart as 'before' | 'after' | undefined;
        const mark = node.querySelector<HTMLElement>('[data-chain-line]');
        found = { threadId: id, ...(part ? { part } : {}), lineHidden: !mark || mark.getBoundingClientRect().bottom < box.top + 4 };
      }
      setFocus(previous => previous && found && previous.threadId === found.threadId && previous.part === found.part && previous.lineHidden === found.lineHidden ? previous : found);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    scroller.addEventListener('scroll', schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    schedule();
    return () => { scroller.removeEventListener('scroll', schedule); observer.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [merged, thread.id, segments.length, later.length]);
  useEffect(() => { onFocus?.(focus); }, [focus?.threadId, focus?.part]); // eslint-disable-line react-hooks/exhaustive-deps
  const lineOf = (target: { thread: Thread; part?: 'before' | 'after' }) => <ChainLine thread={target.thread} part={target.part} agentLabel={agentLabel} icon={agentIcon?.(target.thread.agent)} onOpen={onOpenSegment} />;
  const laterBlock = <>
    {later.map(segment => <EarlierSegment key={entryKey(segment)} segment={segment} api={api} agentLabel={agentLabel} line={merged ? lineOf(segment) : null}
      onQuote={current.onQuote} onMessageContext={current.onMessageContext} onHandToAssistant={current.onHandToAssistant} onAutoHandover={current.onAutoHandover} fork={canFork(segment.thread)} onFork={turn => onSegmentFork(segment.thread, turn)}
      onOpenFile={path => onSegmentFile(segment.thread, path)} onPreview={path => onSegmentPreview(segment.thread, path)} onOpenSegment={onOpenSegment}
      older={{ observeOlder: false, chain: true }} prefix={null} />)}
    {laterFailed
      ? <div className="history-status" role="alert">{t('handover.chain.laterFailed')} <button className="text-btn" onClick={() => setLaterFailed(false)}>{t('common.retry')}</button></div>
      : hasLater
        ? <div ref={sentinel} className="chain-later" role={loadingLater ? 'status' : undefined}>{loadingLater ? t('common.loading') : null}</div>
        : null}
  </>;
  if (!merged) return later.length || hasLater ? <div className="merged-history" ref={root}><ThreadView {...current} />{laterBlock}</div> : <ThreadView {...current} />;
  const localOlder = segments.length ? segments[0].page.hasOlder : current.hasOlder;
  const oldest = segments[0] ?? { thread, part: currentPart };
  const more = Boolean(localOlder || olderOf(oldest));
  const olderProps = { hasOlder: ready && more, loadingOlder: loading || Boolean(current.loadingOlder), onLoadOlder: load,
    olderLabel: localOlder ? undefined : t('handover.chain.loadPrevious'),
    chain: true, observeOlder: true, olderError: error ? t(error === 'missing' ? 'handover.chain.missing' : 'handover.chain.failed') : undefined };
  const beginning = ready && !more ? <div className="row chain-beginning" role="status">{t('handover.chain.beginning')}</div> : null;
  const head = latest ?? thread;
  const floating = focus?.lineHidden && (focus.threadId !== head.id || focus.part === 'before') ? focusEntry(focus, [...segments, { thread, part: currentPart }, ...later]) : null;
  return <div className="merged-history" ref={root}>
    {/* Overlays the text from the top of the reading; sticky with no height of its own, so nothing moves. */}
    <div className="chain-float" aria-live="polite">
      {floating && <div className="chain-line chain-line-float">{lineBody({ thread: floating.thread, part: floating.part, agentLabel, icon: agentIcon?.(floating.thread.agent), onOpen: onOpenSegment })}
        <button type="button" className="chain-line-latest" aria-label={t('handover.chain.goLatest')} title={t('handover.chain.goLatest')} onClick={onGoLatest}><IconArrowDown size={14} /></button></div>}
    </div>
    {segments.map((segment, i) => <EarlierSegment key={entryKey(segment)} segment={segment} api={api} agentLabel={agentLabel} line={lineOf(segment)}
      onQuote={current.onQuote} onMessageContext={current.onMessageContext} onHandToAssistant={current.onHandToAssistant} onAutoHandover={current.onAutoHandover} fork={canFork(segment.thread)} onFork={turn => onSegmentFork(segment.thread, turn)}
      onOpenFile={path => onSegmentFile(segment.thread, path)} onPreview={path => onSegmentPreview(segment.thread, path)} onOpenSegment={onOpenSegment}
      older={i === 0 ? olderProps : { observeOlder: false, chain: true }} prefix={i === 0 ? beginning : null} />)}
    <div data-history-thread={thread.id} data-history-part={currentPart} className="history-segment current-segment">
      <ThreadView {...current} {...(segments.length ? { hasOlder: false, observeOlder: false, chain: true } : olderProps)}
        beforeItems={<>{!segments.length && beginning}{ready && !current.hasOlder && lineOf({ thread, part: currentPart })}{ready && !current.hasOlder && (handedOver(thread) || thread.handback) && <HandoverBoundary api={api} thread={thread} part={currentPart} agentLabel={agentLabel} turnId={current.items.find(item => item.kind === 'user' && item.handoverCollapsed)?.turnId ?? undefined} />}</>}
      />
    </div>
    {laterBlock}
  </div>;
}

function focusEntry(focus: ChainFocus, segments: Array<{ thread: Thread; part?: 'before' | 'after' }>) {
  return segments.find(item => item.thread.id === focus.threadId && (item.part ?? 'after') === (focus.part ?? 'after'));
}

function lineBody({ thread, part, agentLabel, icon, onOpen }: { thread: Thread; part?: 'before' | 'after'; agentLabel: Props['agentLabel']; icon?: string; onOpen?: (thread: Thread) => void }) {
  const at = part === 'after' && thread.handback ? thread.handback.at : thread.createdAt;
  const title = thread.title;
  return <>
    <span className="chain-line-text">
      {icon ? <AgentMark path={icon} size={13} /> : null}
      <button type="button" className="chain-line-title" title={thread.title} onClick={() => onOpen?.(thread)}>{title}</button>
      <span className="chain-line-meta">· {agentLabel(thread.agent)}<span className="chain-line-time"> · {clockLabel(at)}</span></span>
    </span>
  </>;
}

/** The hairline between two segments: where one conversation ends and the next begins, with the way into it. */
function ChainLine({ thread, part, agentLabel, icon, onOpen }: { thread: Thread; part?: 'before' | 'after'; agentLabel: Props['agentLabel']; icon?: string; onOpen?: (thread: Thread) => void }) {
  return <div className="row chain-line" data-chain-line={`${thread.id}:${part ?? 'after'}`}>{lineBody({ thread, part, agentLabel, icon, onOpen })}</div>;
}

function EarlierSegment({ segment, api, agentLabel, line, fork, onFork, onQuote, onMessageContext, onHandToAssistant, onAutoHandover, onOpenFile, onPreview, onOpenSegment, older, prefix }: {
  segment: Segment; api: Api; agentLabel: Props['agentLabel']; fork: ReturnType<Props['canFork']>; line: ReactNode;
  onFork: (id: string) => void; onOpenFile: (path: string) => Promise<void>; onPreview: (path: string) => void; onOpenSegment?: (thread: Thread, alone?: boolean) => void;
  older: Partial<ViewProps>; prefix: ReactNode; onQuote?: ViewProps['onQuote']; onMessageContext?: ViewProps['onMessageContext']; onHandToAssistant?: ViewProps['onHandToAssistant']; onAutoHandover?: ViewProps['onAutoHandover'];
}) {
  const { thread, page } = segment;
  const timeline = useMemo(() => buildTimeline(page.events), [page.events]);
  const roots = useMemo(() => [thread.cwd, thread.cwdReal], [thread.cwd, thread.cwdReal]);
  const loadImage = useMemo(() => (id: string) => api.attachment(thread.id, id), [api, thread.id]);
  const loadFile = useMemo(() => (path: string) => api.threadFile(thread.id, path), [api, thread.id]);
  // Reading a thread the chain came back to from its earlier part, its handover (the one it was
  // made from) is the fold; the part after the return opens with what it was handed back.
  const folded = segment.part === 'after' ? Boolean(thread.handback) : segment.part === 'before' ? handedOver(thread) : handedOver(thread) || Boolean(thread.handback);
  return <div data-history-thread={thread.id} data-history-part={segment.part} className="history-segment">
    <ThreadView onQuote={onQuote} onMessageContext={onMessageContext} onHandToAssistant={onHandToAssistant} onAutoHandover={onAutoHandover} historyApi={api} historyThreadId={thread.id} items={timeline.items} roots={roots} loadImage={loadImage} loadFile={loadFile}
      onOpenFile={onOpenFile} onPreview={onPreview} onFork={fork.enabled ? onFork : undefined} forkAnyTurn={fork.any} {...older}
      beforeItems={<>{prefix}{!page.hasOlder && line}{!page.hasOlder && folded && <HandoverBoundary api={api} thread={thread} part={segment.part} agentLabel={agentLabel} turnId={timeline.items.find(item => item.kind === 'user' && item.handoverCollapsed)?.turnId ?? (segment.part === 'before' ? page.events.find(event => event.type === 'turn.started')?.turnId : undefined) ?? undefined} />}
        {!timeline.items.length && <div className="row chain-beginning">{t('handover.chain.empty')}</div>}</>} />
    {segment.followups > 0 && <div className="row chain-followups">
      {t('handover.chain.followups', thread.title, segment.followups)} · <button type="button" className="text-btn" onClick={() => onOpenSegment?.(thread, true)}>{t('handover.chain.followupsOpen')}</button>
    </div>}
  </div>;
}

function HandoverBoundary({ api, thread, part, agentLabel, turnId }: { api: Api; thread: Thread; part?: 'before' | 'after'; agentLabel: Props['agentLabel']; turnId?: string }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<Awaited<ReturnType<Api['historyHandover']>> | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // The part of a thread the chain came back to that comes after the return is folded by what it was handed back.
  const returned = Boolean(thread.handback) && part !== 'before';
  useEffect(() => {
    let alive = true; setLoading(true); setFailed(false);
    void api.historyHandover(thread.id, open, part === 'before' ? 'before' : undefined).then(value => { if (alive) setInfo(value); })
      .catch(() => { if (alive) setFailed(true); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [api, thread.id, turnId, open, attempt, part]);
  // A copied conversation (`resume`) with no resent turn has nothing to fold under the divider.
  const hasFold = returned || !(thread.handover?.method === 'resume' && !turnId);
  // By hand it is a conversation of its own that was started from the source; the reason an automatic relay happened does not apply.
  const manual = !returned && !thread.handover!.automatic;
  const reason = manual ? '' : info?.reason === 'plan_exhausted' ? t('handover.chain.exhausted') : info?.reason === 'interrupted' ? t('handover.chain.interrupted') : info?.reason ? t('handover.chain.error') : '';
  const kind = !info?.size ? '' : info.method === 'resume' ? t('handover.card.resume') : t(info.method === 'summary' || info.method === 'return' ? 'handover.card.summary' : 'handover.card.text', info.size);
  const sourceAgent = returned ? info?.source.agent ?? '' : thread.handover!.agent;
  // Like the plan in the conversation: one quiet line that folds out into the whole text, hung under a hairline.
  return <div className="row handover-boundary" data-handover-thread={thread.id} data-turn={turnId}>
    <div className="fork-mark">
      <span className="fork-mark-label"><IconHandover size={15} />{returned ? t('handover.trail.returned', agentLabel(sourceAgent)) : manual ? t('handover.trail.manual', agentLabel(thread.handover!.agent), agentLabel(thread.agent)) : t('handover.trail.from', agentLabel(thread.handover!.agent))}{reason ? ` · ${reason}` : ''}</span>
    </div>
    {hasFold && failed && <div className="history-status" role="alert">{t('handover.chain.detailFailed')} <button className="text-btn" onClick={() => setAttempt(n => n + 1)}>{t('common.retry')}</button></div>}
    {hasFold && !failed && !info && <div className="handover-card-head placeholder" aria-hidden="true" />}
    {hasFold && !failed && info && !info.size && info.method !== 'resume' && <div className="handover-card-empty">{t('handover.chain.noSummary')}</div>}
    {!failed && info && info.size > 0 && <div className={`handover-card${open ? ' open' : ''}`}>
      <button type="button" className="handover-card-head" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <span className="handover-card-kind">{kind}</span>
        {!open && info.preview && <span className="handover-card-preview">{info.preview}</span>}
        <IconChevron size={12} open={open} />
      </button>
      {open && <div className="handover-card-body" role="region" aria-label={t('handover.chain.summary')}>
        {loading || info.text === undefined ? <span role="status">{t('common.loading')}</span> : <Prose text={info.text} />}
      </div>}
    </div>}
  </div>;
}
