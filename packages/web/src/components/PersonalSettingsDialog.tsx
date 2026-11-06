import { useEffect, useRef, useState } from 'react';
import type { AgentInfo, Api, BriefSettings as BriefValue, LarkChannelSettings, ModelOption, PersonalSettings, ProactiveSettings as ProactiveValue } from '../api';
import { t } from '../i18n';
import { Dialog } from './Dialog';
import { DirectoryPicker } from './DirectoryPicker';
import { AgentPicker } from './Pickers';
import { BriefSettings } from './BriefSettings';
import { LarkSettings } from './LarkSettings';
import { pickAgent, startsNewConversation } from '../personal-settings';
import { addRepo, settingsPayload } from '../proactive';
import { ProactiveSettings } from './ProactiveSettings';
import { Popover } from './Popover';
import { ProfileDialog } from './ProfileDialog';
import { readPetPresence, savePetPresence } from './Pet';
import type { PetPresence } from '../pet';
import { IconChevron, IconFolder, IconSearch } from './icons';

export function PersonalSettingsDialog({ api, agents, initial, onSave, onClose, setupNeeded, onExplore }: {
  setupNeeded?: boolean | null; onExplore?: () => void;
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
  // Her presence on this device: chosen here, taking effect at once like the appearance settings.
  const [petPresence, setPetPresence] = useState<PetPresence>(readPetPresence);
  // What the Lark, brief and proactive sections would change; nothing leaves this dialog until Save.
  const larkDraft = useRef<LarkChannelSettings | null>(null);
  const [profileBlank, setProfileBlank] = useState<boolean | null>(null);
  const [editingProfile, setEditingProfile] = useState(false);
  useEffect(() => { let live = true; void api.personalProfile().then(profile => { if (live) setProfileBlank(profile.isTemplate); }).catch(() => undefined); return () => { live = false; }; }, [api]);
  const briefDraft = useRef<BriefValue | null>(null);
  const proactiveDraft = useRef<ProactiveValue | null>(null);
  const [pickingRepo, setPickingRepo] = useState(false);
  useEffect(() => { let live = true; void api.workdirs().then(v => { if (live) setRoots(v.workdirs); }).catch(e => { if (live) setError(String(e)); }); return () => { live = false; }; }, [api, initial.defaultDirectory, retry]);
  useEffect(() => {
    let live = true; setModels(null); setQuery(''); setModelError('');
    if (value.agent) void api.models(value.agent).then(v => { if (live) setModels(v); }).catch(e => { if (live) setModelError(String(e)); });
    return () => { live = false; };
  }, [api, value.agent, retry]);
  const isDefault = value.directory === initial.defaultDirectory || (value.directory === initial.directory && initial.directoryIsDefault);
  const directoryLabel = isDefault ? t('personal.defaultDirectory', initial.defaultDirectoryDisplay ?? initial.directoryDisplay ?? value.directory ?? '') : value.directory === initial.directory ? initial.directoryDisplay ?? value.directory : value.directory;
  if (editingProfile) return <ProfileDialog api={api} onClose={() => setEditingProfile(false)} onSaved={setProfileBlank} />;
  if (picking && roots) return <DirectoryPicker api={api} allowedOnly defaultDirectory={initial.defaultDirectory} roots={roots} selected={value.directory ?? ''} machine="" onRootsChange={() => {}} onManageRoots={() => {}} onSelect={directory => setValue({ ...value, directory })} onClose={() => setPicking(false)} />;
  if (pickingRepo && roots) return <DirectoryPicker api={api} allowedOnly roots={roots} selected="" machine="" onRootsChange={() => {}} onManageRoots={() => {}} onSelect={path => { if (proactiveDraft.current) proactiveDraft.current = addRepo(proactiveDraft.current, path); }} onClose={() => setPickingRepo(false)} />;
  return <Dialog title={t('personal.settings')} className="personal-settings" confirmLabel={t('personal.save')} confirmDisabled={saving || !value.directory || !value.agent} onCancel={() => { if (!saving) onClose(); }} onConfirm={() => {
    setSaving(true); setError('');
    void (async () => {
      const saved = await api.savePersonalSettings({ ...value, directory: isDefault ? null : value.directory });
      if (larkDraft.current) await api.saveLarkChannel(larkDraft.current);
      if (briefDraft.current) await api.saveBriefSettings(briefDraft.current);
      if (proactiveDraft.current) await api.saveProactiveSettings(settingsPayload(proactiveDraft.current));
      onSave(saved);
    })().catch(e => setError(String(e))).finally(() => setSaving(false));
  }}>
    {onExplore && <div className="personal-setting-line"><span>{t(setupNeeded ? 'explore.entryHint' : 'explore.again')}</span><button type="button" className={setupNeeded ? 'primary' : 'ghost'} onClick={onExplore}>{t(setupNeeded ? 'explore.entry' : 'explore.again')}</button></div>}
    <div className="personal-setting-line"><span>{t('personal.directory')}</span><button className="context-btn personal-directory" disabled={!roots} onClick={() => setPicking(true)}><IconFolder size={16} />{directoryLabel || t('personal.chooseDirectory')}</button></div>
    <div className="personal-setting-line"><span>{t('personal.agent')}</span><AgentPicker api={api} agents={agents} value={value.agent ?? ''} onChange={agent => setValue(pickAgent(value, agent))} /></div>
    <div className="personal-setting-line"><span>{t('personal.model')}</span><Popover label={t('personal.model')} placement="below" panelClassName="personal-models" triggerClassName="context-btn" disabled={!value.agent} trigger={<>{!models && !modelError ? t('common.loading') : modelError ? t('common.retry') : models?.find(m => m.id === value.model)?.label ?? value.model ?? t('auto.modelDefault')}<IconChevron size={12} open /></>}>
      {close => <>{models && models.length > 10 && <label className="pop-search"><IconSearch size={15} /><input aria-label={t('personal.searchModels')} placeholder={t('personal.searchModels')} value={query} onChange={e => setQuery(e.target.value)} /></label>}<div className="pop-scroll"><button className="pop-item compact" role="menuitemradio" aria-checked={!value.model} onClick={() => { setValue({ ...value, model: null }); close(); }}>{t('auto.modelDefault')}</button>
        {models?.filter(m => `${m.label} ${m.id}`.toLowerCase().includes(query.trim().toLowerCase())).map(m => <button key={m.id} className="pop-item compact" role="menuitemradio" aria-checked={m.id === value.model} onClick={() => { setValue({ ...value, model: m.id }); close(); }}>{m.label}</button>)}
        </div>{!models && !modelError && <p role="status">{t('common.loading')}</p>}
        {modelError && <p className="panel-error" role="alert">{modelError} <button className="ghost" onClick={() => setRetry(n => n + 1)}>{t('common.retry')}</button></p>}
      </>}
    </Popover></div>
    <div className="personal-setting-line"><span>{t('pet.presenceLabel')}<small>{t('pet.presenceHint')}</small></span>
      <div className="desk-segment" role="group" aria-label={t('pet.presenceLabel')}>
        {(['always', 'event', 'off'] as const).map(mode => (
          <button key={mode} type="button" aria-pressed={petPresence === mode}
            onClick={() => { setPetPresence(mode); savePetPresence(mode); }}>{t(mode === 'always' ? 'pet.presence.always' : mode === 'event' ? 'pet.presence.event' : 'pet.presence.off')}</button>
        ))}
      </div></div>
    <div className="personal-setting-line"><span>{t('profile.title')}<small>{t(profileBlank ? 'profile.blank' : 'profile.hint')}</small></span><button className="ghost profile-open" onClick={() => setEditingProfile(true)}>{t(profileBlank ? 'profile.write' : 'profile.edit')}</button></div>
    <LarkSettings api={api} draft={larkDraft.current} onDraft={next => { larkDraft.current = next; }} />
    <BriefSettings api={api} draft={briefDraft.current} onDraft={next => { briefDraft.current = next; }} />
    <ProactiveSettings api={api} draft={proactiveDraft.current} canPick={Boolean(roots)} onDraft={next => { proactiveDraft.current = next; }} onPickRepo={current => { proactiveDraft.current = current; setPickingRepo(true); }} />
    {startsNewConversation(initial, value) && <p className="personal-warning personal-fork-hint" role="status">{t('personal.newConversation')}</p>}
    {error && <p className="panel-error" role="alert">{error} {!roots && <button className="ghost" onClick={() => { setError(''); setRetry(n => n + 1); }}>{t('common.retry')}</button>}</p>}
  </Dialog>;
}
