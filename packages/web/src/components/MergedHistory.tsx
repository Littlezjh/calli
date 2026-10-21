import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { ApiError, type Api, type Thread } from '../api';
import { historyPage, mergeHistory, type HistoryPage } from '../history';
import { buildTimeline } from '../timeline';
import { t } from '../i18n';
import { IconChevron, IconHandover } from './icons';
import { ThreadView } from './ThreadView';

type ViewProps = ComponentProps<typeof ThreadView>;
type Segment = { thread: Thread; page: HistoryPage };
type Props = ViewProps & {
  api: Api; thread: Thread; merged: boolean; ready: boolean;
  agentLabel: (id: string) => string;
  onBrowseOlder: () => void;
  onSegmentFork: (thread: Thread, turn: string) => void;
  canFork: (thread: Thread) => { enabled: boolean; any: boolean };
  onSegmentFile: (thread: Thread, path: string) => Promise<void>;
  onSegmentPreview: (thread: Thread, path: string) => void;
};

/** Each earlier segment owns its client, cursor and action targets. No ancestor reads on mount. */
export function MergedHistory({ api, thread, merged, ready, agentLabel, onBrowseOlder, onSegmentFork, canFork, onSegmentFile, onSegmentPreview, ...current }: Props) {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<'missing' | 'failed' | null>(null);
  const pending = useRef(false);
  const generation = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const restore = useRef<number | null>(null);
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
    const target = oldest?.thread ?? thread;
    const same = Boolean(oldest?.page.hasOlder);
    const id = same ? target.id : (target.handover?.mode === 'continue' ? target.handover.sourceId : undefined);
    if (!id) return;
    // Broken/cyclic metadata must not repeatedly insert the same conversation.
    if (!same && [thread.id, ...segments.map(s => s.thread.id)].includes(id)) { setError('missing'); return; }
    pending.current = true; setLoading(true); setError(null); onBrowseOlder();
    const version = generation.current;
    try {
      const [source, page] = await Promise.all([
        same ? Promise.resolve(target) : api.thread(id),
        historyPage(api, id, same ? oldest.page.nextCursor ?? undefined : undefined, undefined, true),
      ]);
      if (generation.current !== version) return;
      const scroller = root.current?.closest<HTMLElement>('.scroller');
      if (scroller) restore.current = scroller.scrollHeight - scroller.scrollTop;
      setSegments(previous => same
        ? [{ thread: source, page: { ...page, events: mergeHistory(page.events, previous[0].page.events) } }, ...previous.slice(1)]
        : [{ thread: source, page }, ...previous]);
    } catch (e) {
      if (generation.current === version) setError(e instanceof ApiError && e.status === 404 ? 'missing' : 'failed');
    } finally {
      if (generation.current === version) { pending.current = false; setLoading(false); }
    }
  };
  if (!merged) return <ThreadView {...current} />;
  const localOlder = segments.length ? segments[0].page.hasOlder : current.hasOlder;
  const oldest = segments[0]?.thread ?? thread;
  const more = Boolean(localOlder || oldest.handover?.mode === 'continue');
  const olderProps = { hasOlder: ready && more, loadingOlder: loading || Boolean(current.loadingOlder), onLoadOlder: load,
    olderLabel: localOlder ? undefined : t('handover.chain.loadPrevious'),
    chain: true, observeOlder: true, olderError: error ? t(error === 'missing' ? 'handover.chain.missing' : 'handover.chain.failed') : undefined };
  const beginning = ready && !more ? <div className="row chain-beginning" role="status">{t('handover.chain.beginning')}</div> : null;
  return <div className="merged-history" ref={root}>
    {segments.map((segment, i) => <EarlierSegment key={segment.thread.id} segment={segment} api={api} agentLabel={agentLabel}
      fork={canFork(segment.thread)} onFork={turn => onSegmentFork(segment.thread, turn)}
      onOpenFile={path => onSegmentFile(segment.thread, path)} onPreview={path => onSegmentPreview(segment.thread, path)}
      older={i === 0 ? olderProps : { observeOlder: false, chain: true }} prefix={i === 0 ? beginning : null} />)}
    <div data-history-thread={thread.id} className="history-segment current-segment">
      <ThreadView {...current} {...(segments.length ? { hasOlder: false, observeOlder: false, chain: true } : olderProps)}
        beforeItems={<>{!segments.length && beginning}{ready && !current.hasOlder && thread.handover?.mode === 'continue' && <HandoverBoundary api={api} thread={thread} agentLabel={agentLabel} turnId={current.items.find(item => item.kind === 'user' && item.handoverCollapsed)?.turnId ?? undefined} />}</>}
      />
    </div>
  </div>;
}

function EarlierSegment({ segment, api, agentLabel, fork, onFork, onOpenFile, onPreview, older, prefix }: {
  segment: Segment; api: Api; agentLabel: Props['agentLabel']; fork: ReturnType<Props['canFork']>;
  onFork: (id: string) => void; onOpenFile: (path: string) => Promise<void>; onPreview: (path: string) => void;
  older: Partial<ViewProps>; prefix: ReactNode;
}) {
  const { thread, page } = segment;
  const timeline = useMemo(() => buildTimeline(page.events), [page.events]);
  const roots = useMemo(() => [thread.cwd, thread.cwdReal], [thread.cwd, thread.cwdReal]);
  const loadImage = useMemo(() => (id: string) => api.attachment(thread.id, id), [api, thread.id]);
  const loadFile = useMemo(() => (path: string) => api.threadFile(thread.id, path), [api, thread.id]);
  return <div data-history-thread={thread.id} className="history-segment">
    <ThreadView historyApi={api} historyThreadId={thread.id} items={timeline.items} roots={roots} loadImage={loadImage} loadFile={loadFile}
      onOpenFile={onOpenFile} onPreview={onPreview} onFork={fork.enabled ? onFork : undefined} forkAnyTurn={fork.any} {...older}
      beforeItems={<>{prefix}{!page.hasOlder && thread.handover?.mode === 'continue' && <HandoverBoundary api={api} thread={thread} agentLabel={agentLabel} turnId={page.events.find(event => event.type === 'turn.started')?.turnId ?? undefined} />}
        {!timeline.items.length && <div className="row chain-beginning">{t('handover.chain.empty')}</div>}</>} />
  </div>;
}

function HandoverBoundary({ api, thread, agentLabel, turnId }: { api: Api; thread: Thread; agentLabel: Props['agentLabel']; turnId?: string }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<Awaited<ReturnType<Api['historyHandover']>> | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true; setLoading(true); setFailed(false);
    void api.historyHandover(thread.id, open).then(value => { if (alive) setInfo(value); })
      .catch(() => { if (alive) setFailed(true); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [api, thread.id, turnId, open, attempt]);
  const reason = info?.reason === 'plan_exhausted' ? t('handover.chain.exhausted') : info?.reason === 'interrupted' ? t('handover.chain.interrupted') : info?.reason ? t('handover.chain.error') : '';
  return <div className="row handover-boundary" data-handover-thread={thread.id} data-turn={turnId}>
    <button type="button" className="context-compaction handover-divider" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <IconHandover size={16} /><span>{t('handover.trail.from', agentLabel(thread.handover!.agent))}{reason ? ` · ${reason}` : ''}</span><IconChevron size={12} />
    </button>
    {failed && <div className="history-status" role="alert">{t('handover.chain.detailFailed')} <button className="text-btn" onClick={() => setAttempt(n => n + 1)}>{t('common.retry')}</button></div>}
    {open && !failed && <div className="handover-summary" role="region" aria-label={t('handover.chain.summary')}>
      {loading || info?.text === undefined ? <span role="status">{t('common.loading')}</span> : info.text || t('handover.chain.noSummary')}
    </div>}
  </div>;
}
