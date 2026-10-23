import { historyPage, mergeHistory, watchHistory } from '../history';
import { waitingLabel } from '../notices';
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { AgentInfo, Api, Coordination, Thread } from '../api';
import { buildTalks } from '../coordination';
import { buildTimeline, clockLabel, deliveredPreview, type StoredEvent } from '../timeline';
import { Prose, ThreadView } from './ThreadView';
import { AgentMark, IconAgents, IconChevron, IconClose, IconEdit, IconExternal, IconHandover, IconStop } from './icons';
import { t } from '../i18n';

/** The width the user dragged the panel to, on a wide screen. Unset, the panel keeps its own. */
const WIDTH_KEY = 'rah.agents.width';
const MIN_WIDTH = 320;
/** What the conversation beside the panel is always left with. */
const MIN_MAIN = 380;
const clampWidth = (w: number) => Math.max(MIN_WIDTH, Math.min(w, window.innerWidth - MIN_MAIN));

const labels: Record<string, string> = { queued: t('team.queued'), running: t('status.running'), returned: t('team.returned'), failed: t('team.failed'), stopped: t('team.stopped'), interrupted: t('team.interrupted') };
export function memberStatus(m: Coordination['members'][number]): string {
  if (!m.thread) return t('team.unavailable');
  if (m.thread.waiting) return waitingLabel(m.thread);
  if (m.thread.status === 'running') return t('status.running');
  return labels[m.latest?.state ?? ''] ?? t('team.notDispatched');
}

/**
 * The team at a glance, for the empty margin beside a conversation on a wide screen: who is in it,
 * what each is on and how that stands. A row opens that member; the heading opens the whole panel.
 */
export function TeamCard({ team, agents, onOpen }: { team: Coordination; agents: AgentInfo[]; onOpen: (memberId?: string) => void }) {
  const running = team.members.filter(m => m.thread?.status === 'running').length;
  return <aside className="team-card" aria-label={t('team.collaborators')}>
    <button type="button" className="team-card-head" aria-label={t('team.view')} onClick={() => onOpen()}>
      <IconAgents size={15} /><strong>{t('team.agents')}</strong>
      <span>{team.paused ? t('team.paused') : running ? t('team.running', running) : t('team.count', team.members.length)}</span>
    </button>
    {team.members.map(m => {
      const icon = agents.find(a => a.id === m.thread?.agent)?.icon;
      const state = m.thread?.waiting ? 'waiting' : m.thread?.status === 'running' ? 'running' : m.latest?.state === 'failed' ? 'failed' : 'idle';
      // What it was last asked, or what it last answered once it has.
      const doing = deliveredPreview(state === 'running' || state === 'waiting' ? m.latest?.text ?? '' : m.latest?.result || m.latest?.text || '');
      return <button type="button" className="team-card-row" key={m.id} title={doing} onClick={() => onOpen(m.id)}>
        <span className="team-card-mark">{icon ? <AgentMark path={icon} size={14} /> : <IconAgents size={14} />}</span>
        <span className="team-card-text">
          <span className="team-card-line"><strong>{m.name}{m.thread?.handover && <span className="auto-member-mark" role="img" aria-label={t('auto.transferred')} title={t('auto.transferred')}><IconHandover size={13} /></span>}</strong><span className={`team-card-state ${state}`}>{memberStatus(m)}</span></span>
          {doing && <span className="team-card-doing">{doing}</span>}
        </span>
      </button>;
    })}
  </aside>;
}

/** Who said something in the team: the name it goes by, and the agent behind it for its mark and tag. */
interface Speaker { name: string; tag: string; icon: string | null; lead: boolean }

/** One thing said, the way a chat shows it: a mark, who and when on a line, then the words. */
function Said({ who, to, at, state, text, failed }: { who: Speaker; to?: string; at: string | null; state?: string; text: string; failed?: boolean }) {
  const [open, setOpen] = useState(false);
  const preview = useMemo(() => deliveredPreview(text), [text]);
  // Short words are shown as they are; only what would not fit three lines is folded.
  const long = text.length > 160 || text.split('\n').length > 3;
  return (
    <div className="talk-said">
      <span className={`talk-mark${who.lead ? ' lead' : ''}`}>{who.icon ? <AgentMark path={who.icon} size={16} /> : <IconAgents size={16} />}</span>
      <div className="talk-main">
        <div className="talk-line">
          <strong>{who.name}</strong>
          <span className="talk-tag">{who.tag}</span>
          {to && <span className="talk-to">{t('team.to', to)}</span>}
          {at && <time dateTime={at}>{clockLabel(at)}</time>}
        </div>
        {long && !open ? <p className="talk-preview">{preview}</p> : <Prose className="talk-text" text={text || t('team.noText')} />}
        {(long || state || failed) && (
          <div className="talk-foot">
            {failed && <span className="talk-failed">{t('team.failed')}</span>}
            {state && <span>{state}</span>}
            {long && <button type="button" className="text-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? t('common.collapse') : t('common.expandAll')}</button>}
          </div>
        )}
      </div>
    </div>
  );
}

export function AgentPanel({ api, memberApi, team, agents, leadAgent, memberModel, start, phone, onClose, onOpen, onAdjust, onRefresh, onError }: {
  api: Api; team: Coordination; agents: AgentInfo[]; leadAgent?: string;
  /** How to reach a member that runs on another machine. */
  memberApi?: (host: string) => Api;
  /** The control for a member's own model and thinking effort, shown with its details. */
  memberModel?: (thread: Thread) => ReactNode;
  /** The member to open on, when the panel is opened from that member's row elsewhere. */
  start?: string | null;
  phone: boolean; onClose: () => void; onOpen: (thread: Thread) => void;
  onAdjust: (name: string) => void; onRefresh: () => void; onError: (err: unknown) => void;
}) {
  const [memberId, setMemberId] = useState<string | null>(start ?? null);
  const [width, setWidth] = useState<number | null>(() => { const saved = Number(localStorage.getItem(WIDTH_KEY)); return saved > 0 ? clampWidth(saved) : null; });
  const panel = useRef<HTMLElement>(null);
  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panel.current?.getBoundingClientRect().width ?? MIN_WIDTH;
    const at = (ev: PointerEvent) => clampWidth(startW + startX - ev.clientX);
    const move = (ev: PointerEvent) => setWidth(at(ev));
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      localStorage.setItem(WIDTH_KEY, String(at(ev)));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  // A window made narrower must not leave the panel wider than the room there is.
  useEffect(() => {
    const fit = () => setWidth((w) => (w === null ? w : clampWidth(w)));
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  const [tab, setTab] = useState<'members' | 'talk'>('members');
  // Answers are folded under their message; the newest conversation starts open.
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const talks = useMemo(() => buildTalks(team.messages), [team.messages]);
  const speaker = (id: string): Speaker => {
    const m = team.members.find(v => v.id === id);
    const agent = agents.find(a => a.id === (m ? m.thread?.agent : leadAgent));
    return m ? { name: m.name, tag: agent?.label ?? m.thread?.agent ?? t('team.member'), icon: agent?.icon ?? null, lead: false }
      : { name: team.team?.entry ?? t('team.lead'), tag: agent?.label ?? t('team.leadTag'), icon: agent?.icon ?? null, lead: true };
  };
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [connected, setConnected] = useState(true);
  const [older, setOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const listScroll = useRef(0);
  const focus = useRef<HTMLElement | null>(null);
  const latest = useRef({ onClose, memberId }); latest.current = { onClose, memberId };
  const member = team.members.find(m => m.id === memberId);
  const thread = member?.thread;
  // A member on another machine is read from that machine; it cannot be opened here as a conversation of this one.
  const remote = member?.host;
  const threadApi = useMemo(() => (remote && memberApi ? memberApi(remote) : api), [api, remote]);
  const timeline = useMemo(() => buildTimeline(events), [events]);
  useEffect(() => {
    if (thread?.unread) void threadApi.updateThread(thread.id, { unread: false }).then(onRefresh).catch(() => undefined);
  }, [threadApi, thread?.id, thread?.unread]);
  useEffect(() => {
    focus.current = document.activeElement as HTMLElement;
    // Escape closes what is on top: a setting opened in the panel goes first, the panel after it.
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !panel.current?.querySelector('.pop-panel')) latest.current.onClose(); };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); focus.current?.focus(); };
  }, []);
  useEffect(() => {
    if (!phone) return;
    history.pushState({ limiAgents: true }, '');
    const pop = () => {
      if (latest.current.memberId) { setMemberId(null); history.pushState({ limiAgents: true }, ''); }
      else latest.current.onClose();
    };
    window.addEventListener('popstate', pop);
    return () => { window.removeEventListener('popstate', pop); if (history.state?.limiAgents) history.back(); };
  }, [phone]);
  const historyCursor = useRef<number | null>(null);
  const olderRequest = useRef<object | null>(null);
  useEffect(() => {
    setEvents([]); setOlder(false); setLoadingOlder(false); setConnected(true);
    historyCursor.current = null; olderRequest.current = null; stick.current = true; setAtBottom(true);
    if (!memberId) { requestAnimationFrame(() => { if (body.current) body.current.scrollTop = listScroll.current; }); return; }
    const ctrl = new AbortController();
    void watchHistory(threadApi, memberId, ctrl.signal, {
      page: page => { setEvents(page.events); historyCursor.current = page.nextCursor; setOlder(page.hasOlder); },
      events: batch => setEvents(previous => mergeHistory(previous, batch)),
      error: onError,
      connection: setConnected,
    });
    return () => ctrl.abort();
  }, [threadApi, memberId]);
  useEffect(() => { if (memberId && stick.current && body.current) body.current.scrollTop = body.current.scrollHeight; }, [events, memberId]);
  const loadOlder = async () => {
    if (!memberId || loadingOlder || olderRequest.current || !historyCursor.current) return;
    const id = memberId;
    const request = {}; olderRequest.current = request;
    setLoadingOlder(true);
    const el = body.current; const height = el?.scrollHeight ?? 0;
    try {
      const page = await historyPage(threadApi, id, historyCursor.current);
      if (latest.current.memberId !== id || olderRequest.current !== request) return;
      setEvents(prev => mergeHistory(page.events, prev)); setOlder(page.hasOlder); historyCursor.current = page.nextCursor;
      requestAnimationFrame(() => { if (el) el.scrollTop += el.scrollHeight - height; });
    } catch (err) { if (olderRequest.current === request) onError(err); } finally { if (olderRequest.current === request) { olderRequest.current = null; setLoadingOlder(false); } }
  };
  return <aside ref={panel} className={`agent-panel${memberId ? ' detail' : ''}`} role="region" aria-label={t('team.panel')} style={width === null ? undefined : { ['--agent-panel-width' as string]: `${width}px` }}>
    <div className="agent-panel-resize" onPointerDown={startResize} onDoubleClick={() => { setWidth(null); localStorage.removeItem(WIDTH_KEY); }} role="separator" aria-orientation="vertical" aria-label={t('common.resize')} title={t('team.resizeHint')} />
    <header className="agent-panel-head">
      {memberId && <button className="icon-btn" aria-label={t('team.back')} onClick={() => setMemberId(null)}><span className="coord-back"><IconChevron /></span></button>}
      {/* A member: how it stands first, then its agent and the folder it works in (the whole path on hover). */}
      <div className="agent-panel-heading"><strong>{member?.name ?? t('team.agents')}</strong><span title={thread?.cwd}>{thread ? `${memberStatus(member!)} · ${agents.find(a => a.id === thread.agent)?.label ?? thread.agent}${member?.hostLabel ? ` · ${member.hostLabel}` : ''} · ${thread.cwd.split('/').filter(Boolean).pop() ?? thread.cwd}` : team.paused ? t('team.pausedHint') : t('team.summary', team.members.filter(m => m.thread?.status === 'running').length, team.members.length)}</span></div>
      {thread && !remote && memberModel?.(thread)}
      {thread && !remote && <button className="icon-btn" aria-label={t('team.open')} title={t('team.open')} onClick={() => onOpen(thread)}><IconExternal /></button>}
      <button className="icon-btn" aria-label={t('team.close')} onClick={onClose}><IconClose /></button>
    </header>
    {!memberId && <div className="auto-setting-line"><span>{t('auto.members')}</span><button aria-label={t('auto.members')} className="auto-toggle" role="switch" aria-checked={team.autoHandover !== false} onClick={() => { void api.setCollaborationHandover(team.rootId, team.autoHandover === false).then(onRefresh).catch(onError); }}>{t(team.autoHandover !== false ? 'auto.on' : 'auto.off')}</button></div>}
    {!connected && <div className="agent-panel-notice">{t('team.reconnecting')}</div>}
    <div className="agent-panel-body" ref={body} onScroll={() => {
      if (!body.current) return;
      if (!memberId) listScroll.current = body.current.scrollTop;
      stick.current = body.current.scrollHeight - body.current.scrollTop - body.current.clientHeight < 80;
      setAtBottom(stick.current);
    }}>
      {!memberId && team.messages.length > 0 && <div className="agent-tabs" role="tablist" aria-label={t('team.content')}>
        <button role="tab" aria-selected={tab === 'members'} onClick={() => setTab('members')}>{t('team.membersTab', team.members.length)}</button>
        <button role="tab" aria-selected={tab === 'talk'} onClick={() => setTab('talk')}>{t('team.messagesTab', talks.length)}</button>
      </div>}
      {!memberId && tab === 'talk' && team.messages.length > 0 ? <div className="talks">
        {talks.map((talk, i) => {
          const { root } = talk;
          const open = opened[root.id] ?? i === talks.length - 1;
          const waiting = root.kind === 'message' && !talk.replies.length;
          return <section className="talk" key={root.id}>
            <Said who={speaker(root.from)} to={speaker(root.to).name} at={root.createdAt} text={talk.text} state={waiting ? labels[root.state] ?? root.state : undefined} failed={waiting && root.state === 'failed'} />
            {talk.replies.length > 0 && <button type="button" className="talk-replies" aria-expanded={open} onClick={() => setOpened(prev => ({ ...prev, [root.id]: !open }))}>
              <IconChevron size={13} open={open} />{t('team.replies', talk.replies.length)}{talk.replies.some(r => r.failed) ? ` · ${t('team.someFailed')}` : ''}
            </button>}
            {open && talk.replies.length > 0 && <div className="talk-thread">
              {talk.replies.map(r => <Said key={r.id} who={speaker(r.from)} at={r.at} text={r.text} failed={r.failed} />)}
            </div>}
          </section>;
        })}
      </div> : !memberId ? <>
        {!team.members.length && <div className="agent-panel-empty"><IconAgents size={32} /><strong>{t('team.emptyTitle')}</strong><p>{t('team.emptyHint1')}<br />{t('team.emptyHint2')}</p></div>}
        {team.members.map(m => <button className="agent-member" key={m.id} onClick={() => setMemberId(m.id)}>
          <div className="agent-member-line"><strong>{m.name}{m.thread?.handover && <span className="auto-member-mark" role="img" aria-label={t('auto.transferred')} title={t('auto.transferred')}><IconHandover size={13} /></span>}</strong><span className={m.thread?.waiting ? 'coord-attention' : ''}>{memberStatus(m)}</span></div>
          <div className="coord-caption">{m.thread?.agent}{m.hostLabel ? ` · ${m.hostLabel}` : ''} · {m.thread?.cwd.split('/').slice(-2).join('/')}</div>
          <p>{m.latest?.result?.split(/<limi-(?:coordination|team)>/)[0].slice(-160) || m.latest?.text.slice(0, 160) || t('team.waitingTask')}</p>
          {m.thread?.unread && <span className="coord-unread">{t('team.newOutput')}</span>}
        </button>)}
      </> : thread ? <ThreadView historyApi={threadApi} historyThreadId={thread.id} items={timeline.items} roots={[thread.cwd, thread.cwdReal]} loadImage={id => threadApi.attachment(thread.id, id)} loadFile={path => threadApi.threadFile(thread.id, path)} hasOlder={older} loadingOlder={loadingOlder} onLoadOlder={() => void loadOlder()} /> : <div className="agent-panel-empty">{t('team.childGone')}</div>}
    </div>
    {memberId && !atBottom && <button className="agent-panel-latest" onClick={() => { stick.current = true; if (body.current) body.current.scrollTop = body.current.scrollHeight; }}>{t('team.latest')}</button>}
    {/* A member's way to change course goes through the lead: a line shaped like the composer's,
        which opens the lead's composer with the member named; stop sits where the composer has it. */}
    {member && thread ? <footer className="agent-panel-footer adjust">
      <button className="agent-adjust" onClick={() => onAdjust(member.name)}>
        <IconEdit size={15} /><span>{t('team.adjustPrompt', member.name)}</span>
      </button>
      {thread.status === 'running' && <button className="send-btn stop" aria-label={t('team.stopTask')} title={t('team.stopTask')} onClick={() => { threadApi.cancel(thread.id).then(onRefresh).catch(onError); }}>
        <IconStop size={16} />
      </button>}
    </footer> : <footer className="agent-panel-footer">
      <button title={team.paused ? t('team.resumeHint') : t('team.stopHint')} onClick={() => { api.configureCoordination(team.rootId, { action: team.paused ? 'resume' : 'stop' }).then(onRefresh).catch(onError); }}>{team.paused ? t('team.resume') : t('team.stopAll')}</button>
    </footer>}
  </aside>;
}
