import { useEffect, useState } from 'react';
import type { AgentInfo, Api, ModelOption, PersonalSettings } from '../api';
import { t } from '../i18n';
import { Dialog } from './Dialog';
import { DirectoryPicker } from './DirectoryPicker';
import { AgentPicker } from './Pickers';
import { Popover } from './Popover';
import { IconChevron, IconFolder } from './icons';

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
  useEffect(() => { let live = true; void api.workdirs().then(v => { if (live) setRoots(v.workdirs); }).catch(e => { if (live) setError(String(e)); }); return () => { live = false; }; }, [api, retry]);
  useEffect(() => {
    let live = true; setModels(null); setModelError('');
    if (value.agent) void api.models(value.agent).then(v => { if (live) setModels(v); }).catch(e => { if (live) setModelError(String(e)); });
    return () => { live = false; };
  }, [api, value.agent, retry]);
  if (picking && roots) return <DirectoryPicker api={api} allowedOnly roots={roots} selected={value.directory ?? ''} machine="" onRootsChange={() => {}} onManageRoots={() => {}} onSelect={directory => setValue({ ...value, directory })} onClose={() => setPicking(false)} />;
  return <Dialog title={t('personal.settings')} className="personal-settings" confirmLabel={t('personal.save')} confirmDisabled={saving || !value.directory || !value.agent} onCancel={() => { if (!saving) onClose(); }} onConfirm={() => {
    setSaving(true); setError(''); void api.savePersonalSettings(value).then(onSave).catch(e => setError(String(e))).finally(() => setSaving(false));
  }}>
    <div className="personal-setting-line"><span>{t('personal.directory')}</span><button className="context-btn personal-directory" disabled={!roots} onClick={() => setPicking(true)}><IconFolder size={16} />{value.directory || t('personal.chooseDirectory')}</button></div>
    <div className="personal-setting-line"><span>{t('personal.agent')}</span><AgentPicker api={api} agents={agents} value={value.agent ?? ''} onChange={agent => setValue({ ...value, agent, model: null })} /></div>
    <div className="personal-setting-line"><span>{t('personal.model')}</span><Popover label={t('personal.model')} triggerClassName="context-btn" disabled={!value.agent} trigger={<>{models?.find(m => m.id === value.model)?.label ?? value.model ?? t('auto.modelDefault')}<IconChevron size={12} open /></>}>
      {close => <><button className="pop-item compact" role="menuitemradio" aria-checked={!value.model} onClick={() => { setValue({ ...value, model: null }); close(); }}>{t('auto.modelDefault')}</button>
        {models?.map(m => <button key={m.id} className="pop-item compact" role="menuitemradio" aria-checked={m.id === value.model} onClick={() => { setValue({ ...value, model: m.id }); close(); }}>{m.label}</button>)}
        {!models && !modelError && <p>{t('common.loading')}</p>}
        {modelError && <p className="panel-error" role="alert">{modelError} <button className="ghost" onClick={() => setRetry(n => n + 1)}>{t('common.retry')}</button></p>}
      </>}
    </Popover></div>
    {error && <p className="panel-error" role="alert">{error} {!roots && <button className="ghost" onClick={() => { setError(''); setRetry(n => n + 1); }}>{t('common.retry')}</button>}</p>}
  </Dialog>;
}
