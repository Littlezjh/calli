import { useState } from 'react';
import { waitingLabel } from '../notices';
import type { Api, Thread } from '../api';
import { handoverGroups } from '../sidebar';
import { latestHandoverThread } from '../handover';
import { Dialog } from './Dialog';
import { Popover } from './Popover';
import { formatDateTime, t } from '../i18n';

export function HandoverTrail({ api, thread, threads, agentLabel, onSelect, onRefresh, merged, onToggle }: {
  api: Api; merged: boolean; onToggle: () => void; onRefresh: () => void;
  thread: Thread; threads: Thread[]; agentLabel: (id: string) => string; onSelect: (id: string) => void;
}) {
  const [detach, setDetach] = useState(false);
  const [detaching, setDetaching] = useState(false);
  const [error, setError] = useState('');
  const grouped = handoverGroups(threads).find(g => g.members.some(t => t.id === thread.id))?.members ?? [thread];
  // A detached edge splits sidebar cards, but the top audit trail still navigates both sessions.
  const related = new Set([thread.id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const item of threads) if (item.handover && (related.has(item.id) || related.has(item.handover.sourceId))) {
      for (const id of [item.id, item.handover.sourceId]) if (!related.has(id)) { related.add(id); changed = true; }
    }
  }
  const members = related.size > grouped.length ? threads.filter(item => related.has(item.id)) : grouped;
  const canMerge = thread.handover?.mode === 'continue' || latestHandoverThread(thread, threads).id !== thread.id;
  const canDetach = thread.handover?.mode === 'continue' || threads.some(item => item.handover?.mode === 'continue' && item.handover.sourceId === thread.id);
  if (!thread.handover && members.length < 2) return null;
  const source = threads.find((t) => t.id === thread.handover?.sourceId);
  const successors = members.filter((t) => t.handover?.sourceId === thread.id);
  const label = thread.handover ? t('handover.trail.from', agentLabel(source?.agent ?? thread.handover.agent)) : t('handover.trail.to', agentLabel(successors[0]?.agent ?? members[0].agent));
  return <>
    <div className="handover-trail">
      <Popover label={t('handover.trail.title')} triggerClassName="handover-link" panelClassName="handover-panel" trigger={<>{label} · {t('handover.trail.title')}</>}>
        {(close) => <>
          <div className="handover-panel-title">{t('handover.trail.title')}</div>
          {canMerge && <button role="menuitem" className="handover-entry handover-mode" onClick={() => { close(); onToggle(); }}>{t(merged ? 'handover.chain.single' : 'handover.chain.merged')}</button>}
          {canDetach && <button role="menuitem" className="handover-entry handover-mode" onClick={() => { close(); setError(''); setDetach(true); }}>{t('handover.chain.detach')}</button>}
          {members.map((m) => <button key={m.id} role="menuitem" className={`handover-entry${m.id === thread.id ? ' current' : ''}`} onClick={() => { close(); onSelect(m.id); }}>
            <span>{agentLabel(m.agent)} · {m.handover ? t('handover.trail.successor') : t('handover.trail.original')}{m.id === thread.id ? ` · ${t('handover.trail.current')}` : ''}</span>
            <small>{m.handover && <>{t(m.handover.detached ? 'handover.mode.detached' : m.handover.automatic ? 'handover.mode.continue' : 'handover.mode.branch')} · </>}{m.title}</small>
            <small>{formatDateTime(m.createdAt)} · {m.waiting ? waitingLabel(m) : m.status === 'running' ? t('status.running') : m.status === 'error' ? t('status.error') : t('status.idle')}</small>
          </button>)}
          {thread.handover && !source && <div className="handover-missing">{t('handover.trail.from', agentLabel(thread.handover.agent))} · {thread.handover.title}<br />{t('handover.trail.missing')}</div>}
        </>}
      </Popover>
    </div>
    {detach && <Dialog title={t('handover.detach.title')} message={t('handover.detach.message')} confirmLabel={t('handover.detach.confirm')} confirmDisabled={detaching}
      onCancel={() => { if (!detaching) setDetach(false); }} onConfirm={() => {
        setDetaching(true); setError('');
        void api.detachAutomaticHandover(thread.id).then(() => { setDetach(false); onRefresh(); }).catch(e => setError(String(e))).finally(() => setDetaching(false));
      }}>{error && <p className="panel-error" role="alert">{error}</p>}</Dialog>}
  </>;
}
