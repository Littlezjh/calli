import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { AgentInfo, Api, Coordination, Thread } from '../api';
import { buildTalks } from '../coordination';
import { buildTimeline, clockLabel, deliveredPreview, type StoredEvent } from '../timeline';
import { Prose, ThreadView } from './ThreadView';
import { AgentMark, IconAgents, IconChevron, IconClose } from './icons';

/** The width the user dragged the panel to, on a wide screen. Unset, the panel keeps its own. */
const WIDTH_KEY = 'rah.agents.width';
const MIN_WIDTH = 320;
/** What the conversation beside the panel is always left with. */
const MIN_MAIN = 380;
const clampWidth = (w: number) => Math.max(MIN_WIDTH, Math.min(w, window.innerWidth - MIN_MAIN));

const labels: Record<string, string> = { queued: '排队中', running: '运行中', returned: '已返回', failed: '失败', stopped: '已停止', interrupted: '中断' };
export function memberStatus(m: Coordination['members'][number]): string {
  if (!m.thread) return '不可用';
  if (m.thread.waiting) return '待批准';
  if (m.thread.status === 'running') return '运行中';
  return labels[m.latest?.state ?? ''] ?? '尚未派发';
}

/**
 * The team at a glance, for the empty margin beside a conversation on a wide screen: who is in it,
 * what each is on and how that stands. A row opens that member; the heading opens the whole panel.
 */
export function TeamCard({ team, agents, onOpen }: { team: Coordination; agents: AgentInfo[]; onOpen: (memberId?: string) => void }) {
  const running = team.members.filter(m => m.thread?.status === 'running').length;
  return <aside className="team-card" aria-label="协作智能体">
    <button type="button" className="team-card-head" aria-label="查看智能体" onClick={() => onOpen()}>
      <IconAgents size={15} /><strong>智能体</strong>
      <span>{team.paused ? '已暂停' : running ? `${running} 运行中` : `${team.members.length} 个`}</span>
    </button>
    {team.members.map(m => {
      const icon = agents.find(a => a.id === m.thread?.agent)?.icon;
      const state = m.thread?.waiting ? 'waiting' : m.thread?.status === 'running' ? 'running' : m.latest?.state === 'failed' ? 'failed' : 'idle';
      // What it was last asked, or what it last answered once it has.
      const doing = deliveredPreview(state === 'running' || state === 'waiting' ? m.latest?.text ?? '' : m.latest?.result || m.latest?.text || '');
      return <button type="button" className="team-card-row" key={m.id} title={doing} onClick={() => onOpen(m.id)}>
        <span className="team-card-mark">{icon ? <AgentMark path={icon} size={14} /> : <IconAgents size={14} />}</span>
        <span className="team-card-text">
          <span className="team-card-line"><strong>{m.name}</strong><span className={`team-card-state ${state}`}>{memberStatus(m)}</span></span>
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
          {to && <span className="talk-to">发给 {to}</span>}
          {at && <time dateTime={at}>{clockLabel(at)}</time>}
        </div>
        {long && !open ? <p className="talk-preview">{preview}</p> : <Prose className="talk-text" text={text || '没有文字输出。'} />}
        {(long || state || failed) && (
          <div className="talk-foot">
            {failed && <span className="talk-failed">失败</span>}
            {state && <span>{state}</span>}
            {long && <button type="button" className="text-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? '收起' : '展开全文'}</button>}
          </div>
        )}
      </div>
    </div>
  );
}

export function AgentPanel({ api, team, agents, leadAgent, memberModel, start, phone, onClose, onOpen, onAdjust, onRefresh, onError }: {
  api: Api; team: Coordination; agents: AgentInfo[]; leadAgent?: string;
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
    return m ? { name: m.name, tag: agent?.label ?? m.thread?.agent ?? '成员', icon: agent?.icon ?? null, lead: false }
      : { name: '主智能体', tag: agent?.label ?? '主控', icon: agent?.icon ?? null, lead: true };
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
  const timeline = useMemo(() => buildTimeline(events), [events]);
  useEffect(() => {
    if (thread?.unread) void api.updateThread(thread.id, { unread: false }).then(onRefresh).catch(() => undefined);
  }, [api, thread?.id, thread?.unread]);
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
  useEffect(() => {
    setEvents([]); setOlder(false); setConnected(true); stick.current = true; setAtBottom(true);
    if (!memberId) { requestAnimationFrame(() => { if (body.current) body.current.scrollTop = listScroll.current; }); return; }
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const id = memberId;
    const run = async () => {
      let after = 0;
      let loaded = false;
      while (!ctrl.signal.aborted) {
        try {
          if (!loaded) {
            const initial = await api.eventsTail(id);
            if (ctrl.signal.aborted) return;
            setEvents(initial); after = initial.at(-1)?.seq ?? 0; setOlder((initial[0]?.seq ?? 0) > 1); loaded = true;
          }
          setConnected(true);
          await api.stream(`/api/threads/${id}/stream?after=${after}`, ev => {
            after = Math.max(after, ev.seq);
            setEvents(prev => prev.some(e => e.seq === ev.seq) ? prev : [...prev, ev]);
          }, ctrl.signal);
        } catch { /* Reconnect with the last received sequence, including initial-load failures. */ }
        if (!ctrl.signal.aborted) {
          setConnected(false);
          await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); ctrl.signal.removeEventListener('abort', done); resolve(); };
            timer = setTimeout(done, 1500); ctrl.signal.addEventListener('abort', done, { once: true });
          });
        }
      }
    };
    void run();
    return () => { ctrl.abort(); clearTimeout(timer); };
  }, [api, memberId]);
  useEffect(() => { if (memberId && stick.current && body.current) body.current.scrollTop = body.current.scrollHeight; }, [events, memberId]);
  const loadOlder = async () => {
    if (!memberId || loadingOlder || !events.length) return;
    setLoadingOlder(true);
    const el = body.current; const height = el?.scrollHeight ?? 0;
    try {
      const before = await api.eventsBefore(memberId, events[0].seq);
      setEvents(prev => [...before, ...prev]); setOlder((before[0]?.seq ?? 0) > 1);
      requestAnimationFrame(() => { if (el) el.scrollTop += el.scrollHeight - height; });
    } catch (err) { onError(err); } finally { setLoadingOlder(false); }
  };
  return <aside ref={panel} className={`agent-panel${memberId ? ' detail' : ''}`} role="region" aria-label="智能体面板" style={width === null ? undefined : { ['--agent-panel-width' as string]: `${width}px` }}>
    <div className="agent-panel-resize" onPointerDown={startResize} onDoubleClick={() => { setWidth(null); localStorage.removeItem(WIDTH_KEY); }} role="separator" aria-orientation="vertical" aria-label="调整宽度" title="拖动调整宽度，双击恢复" />
    <header className="agent-panel-head">
      {memberId && <button className="icon-btn" aria-label="返回智能体列表" onClick={() => setMemberId(null)}><span className="coord-back"><IconChevron /></span></button>}
      <div className="agent-panel-heading"><strong>{member?.name ?? '智能体'}</strong><span>{thread ? (agents.find(a => a.id === thread.agent)?.label ?? thread.agent) : team.paused ? '已暂停，发消息即可继续' : `${team.members.filter(m => m.thread?.status === 'running').length} 运行中 · ${team.members.length} 个成员`}</span></div>
      {thread && memberModel?.(thread)}
      <button className="icon-btn" aria-label="关闭智能体面板" onClick={onClose}><IconClose /></button>
    </header>
    {thread && <div className="agent-panel-location" title={thread.cwd}>{memberStatus(member!)} · {thread.cwd}</div>}
    {!connected && <div className="agent-panel-notice">连接中断，正在重连；状态可能未更新</div>}
    <div className="agent-panel-body" ref={body} onScroll={() => {
      if (!body.current) return;
      if (!memberId) listScroll.current = body.current.scrollTop;
      stick.current = body.current.scrollHeight - body.current.scrollTop - body.current.clientHeight < 80;
      setAtBottom(stick.current);
    }}>
      {!memberId && team.messages.length > 0 && <div className="agent-tabs" role="tablist" aria-label="智能体面板内容">
        <button role="tab" aria-selected={tab === 'members'} onClick={() => setTab('members')}>成员 · {team.members.length}</button>
        <button role="tab" aria-selected={tab === 'talk'} onClick={() => setTab('talk')}>消息 · {talks.length}</button>
      </div>}
      {!memberId && tab === 'talk' && team.messages.length > 0 ? <div className="talks">
        {talks.map((talk, i) => {
          const { root } = talk;
          const open = opened[root.id] ?? i === talks.length - 1;
          const waiting = root.kind === 'message' && !talk.replies.length;
          return <section className="talk" key={root.id}>
            <Said who={speaker(root.from)} to={speaker(root.to).name} at={root.createdAt} text={talk.text} state={waiting ? labels[root.state] ?? root.state : undefined} failed={waiting && root.state === 'failed'} />
            {talk.replies.length > 0 && <button type="button" className="talk-replies" aria-expanded={open} onClick={() => setOpened(prev => ({ ...prev, [root.id]: !open }))}>
              <IconChevron size={13} open={open} />{talk.replies.length} 条回复{talk.replies.some(r => r.failed) ? ' · 有失败' : ''}
            </button>}
            {open && talk.replies.length > 0 && <div className="talk-thread">
              {talk.replies.map(r => <Said key={r.id} who={speaker(r.from)} at={r.at} text={r.text} failed={r.failed} />)}
            </div>}
          </section>;
        })}
      </div> : !memberId ? <>
        {!team.members.length && <div className="agent-panel-empty"><IconAgents size={32} /><strong>尚未派发任务</strong><p>在输入框输入 @ 选择助手，<br />告诉主智能体如何分工。</p></div>}
        {team.members.map(m => <button className="agent-member" key={m.id} onClick={() => setMemberId(m.id)}>
          <div className="agent-member-line"><strong>{m.name}</strong><span className={m.thread?.waiting ? 'coord-attention' : ''}>{memberStatus(m)}</span></div>
          <div className="coord-caption">{m.thread?.agent} · {m.thread?.cwd.split('/').slice(-2).join('/')}</div>
          <p>{m.latest?.result?.split('<limi-coordination>')[0].slice(-160) || m.latest?.text.slice(0, 160) || '等待任务'}</p>
          {m.thread?.unread && <span className="coord-unread">有新输出</span>}
        </button>)}
      </> : thread ? <ThreadView items={timeline.items} roots={[thread.cwd, thread.cwdReal]} loadImage={id => api.attachment(thread.id, id)} loadFile={path => api.threadFile(thread.id, path)} onDecide={(id, option) => { api.decide(id, option === null ? { cancel: true } : { optionId: option }).then(onRefresh).catch(onError); }} hasOlder={older} loadingOlder={loadingOlder} onLoadOlder={() => void loadOlder()} /> : <div className="agent-panel-empty">该子线程已不可用</div>}
    </div>
    {memberId && !atBottom && <button className="agent-panel-latest" onClick={() => { stick.current = true; if (body.current) body.current.scrollTop = body.current.scrollHeight; }}>查看最新输出</button>}
    <footer className="agent-panel-footer">
      {member && thread ? <>
        <button onClick={() => onAdjust(member.name)}>让主智能体调整</button>
        <button onClick={() => onOpen(thread)}>展开查看</button>
        {thread.status === 'running' && <button onClick={() => { api.cancel(thread.id).then(onRefresh).catch(onError); }}>停止任务</button>}
      </> : <button title={team.paused ? '让排队的消息继续投递；给主智能体发消息也会继续' : '停下主智能体和所有成员正在做的事，排队的消息不再投递'} onClick={() => { api.configureCoordination(team.rootId, { action: team.paused ? 'resume' : 'stop' }).then(onRefresh).catch(onError); }}>{team.paused ? '继续协作' : '全部停止'}</button>}
    </footer>
  </aside>;
}
