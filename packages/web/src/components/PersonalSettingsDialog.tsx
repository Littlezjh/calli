import { useEffect, useState } from 'react';
import type { AgentInfo, Api, ModelOption, PersonalSettings } from '../api';
import { t } from '../i18n';
import { Dialog } from './Dialog';
import { DirectoryPicker } from './DirectoryPicker';
import { AgentPicker } from './Pickers';
import { Popover } from './Popover';
import { IconChevron, IconFolder, IconSearch } from './icons';

export function PersonalSettingsDialog({ api, agents, initial, onSave, onClose }: {
  api: Api; agents: AgentInfo[]; initial: PersonalSettings; onSave: (value: PersonalSettings) => void; onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [roots, setRoots] = useState<string[] | null>(null);
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const [modelError, setModelError] = useState('');
  const [saving, setSaving] = useState(false);
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState('');
  useEffect(() => { let live = true; void api.workdirs().then(v => { if (live) setRoots(v.workdirs); }).catch(e => { if (live) setError(String(e)); }); return () => { live = false; }; }, [api, initial.defaultDirectory, retry]);
  useEffect(() => {
    let live = true; setModels(null); setQuery(''); setModelError('');
    if (value.agent) void api.models(value.agent).then(v => { if (live) setModels(v); }).catch(e => { if (live) setModelError(String(e)); });
    return () => { live = false; };
  }, [api, value.agent, retry]);
  const isDefault = value.directory === initial.defaultDirectory || (value.directory === initial.directory && initial.directoryIsDefault);
  const directoryLabel = isDefault ? t('personal.defaultDirectory', initial.defaultDirectoryDisplay ?? initial.directoryDisplay ?? value.directory ?? '') : value.directory === initial.directory ? initial.directoryDisplay ?? value.directory : value.directory;
  if (picking && roots) return <DirectoryPicker api={api} allowedOnly defaultDirectory={initial.defaultDirectory} roots={roots} selected={value.directory ?? ''} machine="" onRootsChange={() => {}} onManageRoots={() => {}} onSelect={directory => setValue({ ...value, directory })} onClose={() => setPicking(false)} />;
  return <Dialog title={t('personal.settings')} className="personal-settings" confirmLabel={t('personal.save')} confirmDisabled={saving || !value.directory || !value.agent} onCancel={() => { if (!saving) onClose(); }} onConfirm={() => {
    setSaving(true); setError(''); void api.savePersonalSettings({ ...value, directory: isDefault ? null : value.directory }).then(onSave).catch(e => setError(String(e))).finally(() => setSaving(false));
  }}>
    <div className="personal-setting-line"><span>{t('personal.directory')}</span><button className="context-btn personal-directory" disabled={!roots} onClick={() => setPicking(true)}><IconFolder size={16} />{directoryLabel || t('personal.chooseDirectory')}</button></div>
    <div className="personal-setting-line"><span>{t('personal.agent')}</span><AgentPicker api={api} agents={agents} value={value.agent ?? ''} onChange={agent => setValue({ ...value, agent, model: null })} /></div>
    <div className="personal-setting-line"><span>{t('personal.model')}</span><Popover label={t('personal.model')} placement="below" panelClassName="personal-models" triggerClassName="context-btn" disabled={!value.agent} trigger={<>{!models && !modelError ? t('common.loading') : modelError ? t('common.retry') : models?.find(m => m.id === value.model)?.label ?? value.model ?? t('auto.modelDefault')}<IconChevron size={12} open /></>}>
      {close => <>{models && models.length > 10 && <label className="pop-search"><IconSearch size={15} /><input aria-label={t('personal.searchModels')} placeholder={t('personal.searchModels')} value={query} onChange={e => setQuery(e.target.value)} /></label>}<div className="pop-scroll"><button className="pop-item compact" role="menuitemradio" aria-checked={!value.model} onClick={() => { setValue({ ...value, model: null }); close(); }}>{t('auto.modelDefault')}</button>
        {models?.filter(m => `${m.label} ${m.id}`.toLowerCase().includes(query.trim().toLowerCase())).map(m => <button key={m.id} className="pop-item compact" role="menuitemradio" aria-checked={m.id === value.model} onClick={() => { setValue({ ...value, model: m.id }); close(); }}>{m.label}</button>)}
        </div>{!models && !modelError && <p role="status">{t('common.loading')}</p>}
        {modelError && <p className="panel-error" role="alert">{modelError} <button className="ghost" onClick={() => setRetry(n => n + 1)}>{t('common.retry')}</button></p>}
      </>}
    </Popover></div>
    {error && <p className="panel-error" role="alert">{error} {!roots && <button className="ghost" onClick={() => { setError(''); setRetry(n => n + 1); }}>{t('common.retry')}</button>}</p>}
  </Dialog>;
}
