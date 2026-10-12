import { useEffect, useMemo, useRef, useState } from 'react';
import type { Api, Coordination, Thread } from '../api';
import { buildTimeline, type StoredEvent } from '../timeline';
import { ThreadView } from './ThreadView';
import { IconAgents, IconChevron, IconClose } from './icons';

const labels: Record<string, string> = { queued: '排队中', running: '运行中', returned: '已返回', failed: '失败', stopped: '已停止', interrupted: '中断' };
export function memberStatus(m: Coordination['members'][number]): string {
  if (!m.thread) return '不可用';
  if (m.thread.waiting) return '待批准';
  if (m.thread.status === 'running') return '运行中';
  return labels[m.latest?.state ?? ''] ?? '尚未派发';
}

export function AgentPanel({ api, team, phone, onClose, onOpen, onAdjust, onRefresh, onError }: {
  api: Api; team: Coordination; phone: boolean; onClose: () => void; onOpen: (thread: Thread) => void;
  onAdjust: (name: string) => void; onRefresh: () => void; onError: (err: unknown) => void;
}) {
  const [memberId, setMemberId] = useState<string | null>(null);
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
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') latest.current.onClose(); };
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
  return <aside className={`agent-panel${memberId ? ' detail' : ''}`} role="region" aria-label="智能体面板">
    <header className="agent-panel-head">
      {memberId && <button className="icon-btn" aria-label="返回智能体列表" onClick={() => setMemberId(null)}><span className="coord-back"><IconChevron /></span></button>}
      <div className="agent-panel-heading"><strong>{member?.name ?? '智能体'}</strong><span>{thread ? `${thread.agent} · ${thread.model ?? '默认模型'}` : team.paused ? '协作已暂停' : `${team.members.filter(m => m.thread?.status === 'running').length} 运行中 · ${team.members.length} 个成员`}</span></div>
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
      {!memberId ? <>
        {!team.members.length && <div className="agent-panel-empty"><IconAgents size={32} /><strong>尚未派发任务</strong><p>在输入框输入 @ 选择助手，<br />告诉主智能体如何分工。</p></div>}
        {team.members.map(m => <button className="agent-member" key={m.id} onClick={() => setMemberId(m.id)}>
          <div className="agent-member-line"><strong>{m.name}</strong><span className={m.thread?.waiting ? 'coord-attention' : ''}>{memberStatus(m)}</span></div>
          <div className="coord-caption">{m.thread?.agent} · {m.thread?.cwd.split('/').slice(-2).join('/')}</div>
          <p>{m.latest?.result?.split('<limi-coordination>')[0].slice(-160) || m.latest?.text.slice(0, 160) || '等待任务'}</p>
          {m.thread?.unread && <span className="coord-unread">有新输出</span>}
        </button>)}
        {team.messages.length > 0 && <details className="coord-messages"><summary>成员消息 · {team.messages.length}</summary>{team.messages.slice(-20).map(m => <div key={m.id}>
          <strong>{team.members.find(v => v.id === m.from)?.name ?? '主智能体'} → {team.members.find(v => v.id === m.to)?.name ?? '主智能体'}</strong>
          <span>{labels[m.state] ?? m.state}</span><p>{m.text.slice(0, 300)}</p>
        </div>)}</details>}
      </> : thread ? <ThreadView items={timeline.items} running={timeline.running && !timeline.awaitingApproval} roots={[thread.cwd, thread.cwdReal]} loadImage={id => api.attachment(thread.id, id)} loadFile={path => api.threadFile(thread.id, path)} onDecide={(id, option) => { api.decide(id, option === null ? { cancel: true } : { optionId: option }).then(onRefresh).catch(onError); }} hasOlder={older} loadingOlder={loadingOlder} onLoadOlder={() => void loadOlder()} /> : <div className="agent-panel-empty">该子线程已不可用</div>}
    </div>
    {memberId && !atBottom && <button className="agent-panel-latest" onClick={() => { stick.current = true; if (body.current) body.current.scrollTop = body.current.scrollHeight; }}>查看最新输出</button>}
    <footer className="agent-panel-footer">
      {member && thread ? <>
        <button onClick={() => onAdjust(member.name)}>让主智能体调整</button>
        <button onClick={() => onOpen(thread)}>展开查看</button>
        {thread.status === 'running' && <button onClick={() => { api.cancel(thread.id).then(onRefresh).catch(onError); }}>停止任务</button>}
      </> : <button onClick={() => { api.configureCoordination(team.rootId, { action: team.paused ? 'resume' : 'stop' }).then(onRefresh).catch(onError); }}>{team.paused ? '继续协作' : '停止协作'}</button>}
    </footer>
  </aside>;
}
