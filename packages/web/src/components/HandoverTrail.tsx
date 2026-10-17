import { waitingLabel } from '../notices';
import type { Thread } from '../api';
import { handoverGroups } from '../sidebar';
import { Popover } from './Popover';
import { formatDateTime, t } from '../i18n';

export function HandoverTrail({ thread, threads, agentLabel, onSelect }: {
  thread: Thread; threads: Thread[]; agentLabel: (id: string) => string; onSelect: (id: string) => void;
}) {
  const members = handoverGroups(threads).find((g) => g.members.some((t) => t.id === thread.id))?.members ?? [thread];
  if (!thread.handover && members.length < 2) return null;
  const source = threads.find((t) => t.id === thread.handover?.sourceId);
  const successors = members.filter((t) => t.handover?.sourceId === thread.id);
  const label = thread.handover ? t('handover.trail.from', agentLabel(source?.agent ?? thread.handover.agent)) : t('handover.trail.to', agentLabel(successors[0]?.agent ?? members[0].agent));
  return <div className="handover-trail">
    <Popover label={t('handover.trail.title')} triggerClassName="handover-link" panelClassName="handover-panel" trigger={<>{label} · {t('handover.trail.title')}</>}>
      {(close) => <>
        <div className="handover-panel-title">{t('handover.trail.title')}</div>
        {members.map((m) => <button key={m.id} role="menuitem" className={`handover-entry${m.id === thread.id ? ' current' : ''}`} onClick={() => { close(); onSelect(m.id); }}>
          <span>{agentLabel(m.agent)} · {m.handover ? t('handover.trail.successor') : t('handover.trail.original')}{m.id === thread.id ? ` · ${t('handover.trail.current')}` : ''}</span>
          <small>{m.title}</small>
          <small>{formatDateTime(m.createdAt)} · {m.waiting ? waitingLabel(m) : m.status === 'running' ? t('status.running') : m.status === 'error' ? t('status.error') : t('status.idle')}</small>
        </button>)}
        {thread.handover && !source && <div className="handover-missing">{t('handover.trail.from', agentLabel(thread.handover.agent))} · {thread.handover.title}<br />{t('handover.trail.missing')}</div>}
      </>}
    </Popover>
  </div>;
}
