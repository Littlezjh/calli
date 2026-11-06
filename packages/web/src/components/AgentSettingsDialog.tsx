import { useState } from 'react';
import type { AgentInfo, Api } from '../api';
import { t } from '../i18n';
import { DialogSurface } from './Dialog';
import { StreamBridgeOption } from './StreamBridgeOption';

/** Hub-owned runtime choices apply on the next turn, never interrupt a running native task. */
export function AgentSettingsDialog({ api, agent, onReload, onClose }: {
  api: Api; agent: AgentInfo; onReload: () => Promise<void> | void; onClose: () => void;
}) {
  const [enabled, setEnabled] = useState(agent.streamBridgeEnabled ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const capability = agent.capabilities.streamBridge;
  const save = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await api.updateAgent(agent.id, { streamBridge: enabled });
      await onReload();
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };
  return <DialogSurface className="agent-settings-dialog" labelledBy="agent-settings-title" onClose={onClose} busy={busy}>
    <h2 id="agent-settings-title" className="dialog-title">{t('agents.settings')}</h2>
    <p className="dialog-message">{agent.label}</p>
    {capability && <StreamBridgeOption capability={capability} value={enabled} onChange={setEnabled} disabled={busy} />}
    <p className="agent-bridge-hint">{t('streamBridge.nextTurn')}</p>
    {error && <p className="teams-error" role="alert">{error}</p>}
    <div className="dialog-actions">
      <button type="button" className="ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
      <button type="button" className="primary" disabled={busy || enabled === (agent.streamBridgeEnabled ?? false)} onClick={() => void save()}>{t(busy ? 'streamBridge.checking' : 'streamBridge.save')}</button>
    </div>
  </DialogSurface>;
}
