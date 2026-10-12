import type { Thread } from '../api';
import { handoverGroups } from '../sidebar';
import { Popover } from './Popover';

export function HandoverTrail({ thread, threads, agentLabel, onSelect }: {
  thread: Thread; threads: Thread[]; agentLabel: (id: string) => string; onSelect: (id: string) => void;
}) {
  const members = handoverGroups(threads).find((g) => g.members.some((t) => t.id === thread.id))?.members ?? [thread];
  if (!thread.handover && members.length < 2) return null;
  const source = threads.find((t) => t.id === thread.handover?.sourceId);
  const successors = members.filter((t) => t.handover?.sourceId === thread.id);
  const label = thread.handover ? `接手自 ${agentLabel(source?.agent ?? thread.handover.agent)}` : `已交接给 ${agentLabel(successors[0]?.agent ?? members[0].agent)}`;
  return <div className="handover-trail">
    <Popover label="交接记录" triggerClassName="handover-link" panelClassName="handover-panel" trigger={<>{label} · 交接记录</>}>
      {(close) => <>
        <div className="handover-panel-title">交接记录</div>
        {members.map((t) => <button key={t.id} role="menuitem" className={`handover-entry${t.id === thread.id ? ' current' : ''}`} onClick={() => { close(); onSelect(t.id); }}>
          <span>{agentLabel(t.agent)} · {t.handover ? '接手会话' : '原始会话'}{t.id === thread.id ? ' · 当前' : ''}</span>
          <small>{t.title}</small>
          <small>{new Date(t.createdAt).toLocaleString('zh-CN')} · {t.waiting ? '等待批准' : t.status === 'running' ? '运行中' : t.status === 'error' ? '出错' : '空闲'}</small>
        </button>)}
        {thread.handover && !source && <div className="handover-missing">接手自 {agentLabel(thread.handover.agent)} · {thread.handover.title}<br />来源会话已归档、删除或暂不可用</div>}
      </>}
    </Popover>
  </div>;
}
