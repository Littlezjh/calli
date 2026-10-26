import { useEffect, useState } from 'react';
import type { AgentInfo, Api, SupportedAgent } from '../api';
import { t } from '../i18n';
import { DialogSurface } from './Dialog';
import { Popover } from './Popover';
import { AgentMark, IconChevron, IconPlus } from './icons';

export function AgentAccountDialog({ api, agents, onCreated, onDiscover, onClose }: {
  api: Api; agents: AgentInfo[]; onCreated: () => Promise<void>; onDiscover: () => void; onClose: () => void;
}) {
  const [supported, setSupported] = useState<SupportedAgent[] | null>(null);
  const [selected, setSelected] = useState<SupportedAgent | null>(null);
  const [sourceId, setSourceId] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = () => {
    setError('');
    return api.supportedAgents().then(setSupported).catch(e => setError(String(e.message)));
  };
  useEffect(() => { let active = true; api.supportedAgents().then(items => { if (active) setSupported(items); }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, [api]);
  const sources = agents.filter(agent => agent.adapter === selected?.adapter);
  const choose = (item: SupportedAgent) => {
    setSelected(item);
    setSourceId(agents.find(agent => agent.adapter === item.adapter)?.id ?? '');
  };
  const create = async () => {
    if (!selected || busy) return;
    setBusy(true); setError('');
    try {
      await api.createAgentAccount({ adapter: selected.adapter, sourceId: sourceId || undefined, label: label.trim() || undefined });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e)); setBusy(false); return;
    }
    await onCreated();
  };
  return <DialogSurface className="agent-account-dialog" labelledBy="agent-account-title" onClose={onClose} busy={busy}>
    <h2 id="agent-account-title" className="dialog-title">{t('agents.add')}</h2>
    <p className="dialog-message">{t('agentAccount.hint')}</p>
    {!selected ? <>
      {!supported && !error && <p className="dialog-message" role="status">{t('common.loading')}</p>}
      <div className="agent-account-choices">
        {supported?.filter(item => item.capabilities?.createAccount).map(item => <button className="choice-row" key={item.adapter} onClick={() => choose(item)}>
          {item.icon && <AgentMark path={item.icon} size={26} />}
          <span className="choice-text"><span className="choice-label">{item.label}</span><span className="choice-hint">{t('agentAccount.newAccount')}</span></span>
          <IconPlus size={18} />
        </button>)}
      </div>
      {supported && !supported.some(item => item.capabilities?.createAccount) && <p className="dialog-message">{t('agentAccount.none')}</p>}
      <button className="ghost agent-account-discover" onClick={onDiscover}>{t('agentAccount.discover')}</button>
    </> : <>
      <div className="agent-account-selected">{selected.icon && <AgentMark path={selected.icon} size={24} />}<strong>{selected.label}</strong></div>
      <label className="dialog-field"><span>{t('agentAccount.name')}</span><input autoFocus value={label} placeholder={t('agentAccount.autoName')} onChange={event => setLabel(event.target.value)} maxLength={60} disabled={busy} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void create(); }} /></label>
      {sources.length > 0 && <div className="agent-account-source"><span>{t('agentAccount.copyFrom')}</span>
        <Popover label={t('agentAccount.copyFrom')} triggerClassName="ghost" trigger={<>{sources.find(agent => agent.id === sourceId)?.label}<IconChevron size={14} open /></>} disabled={busy} placement="below">
          {close => sources.map(agent => <button className="pop-item compact" role="menuitemradio" aria-checked={sourceId === agent.id} key={agent.id} onClick={() => { setSourceId(agent.id); close(); }}>{agent.label}</button>)}
        </Popover>
      </div>}
      <p className="dialog-message agent-account-note">{t('agentAccount.copyHint')}</p>
    </>}
    {error && <p className="teams-error" role="alert">{error}</p>}
    <div className="dialog-actions">
      <button className="ghost" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
      {!supported && error && <button className="primary" onClick={() => void load()}>{t('agentLogin.retry')}</button>}
      {selected && <button className="primary" onClick={() => void create()} disabled={busy}>{t(busy ? 'agentAccount.creating' : 'agentAccount.create')}</button>}
    </div>
  </DialogSurface>;
}
