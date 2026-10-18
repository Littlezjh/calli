import { useState } from 'react';
import type { ExtensionState, Permission } from '@rah/extension-api';
import type { Api } from '../api';
import { locale, t, type MessageKey } from '../i18n';
import { HostIcon } from '../extensions/ui';
import { needsConfirm } from '../extensions/permissions';
export { needsConfirm } from '../extensions/permissions';
import { Dialog } from './Dialog';
import { IconPuzzle, IconShield } from './icons';

interface Props {
  api: Api;
  /** The made-up workspace: installs are kept on the page only. */
  demo?: boolean;
  /** The catalog and this machine's state, owned by App; null until read. */
  extensions: ExtensionState[] | null;
  /** One extension's new state, straight from the answer: the list shows it before the broadcast comes back. */
  onChange: (state: ExtensionState) => void;
  onError: (e: unknown) => void;
}

const permissionLabel = (p: Permission) => t(`extensions.perm.${p}` as MessageKey);
const permissionHint = (p: Permission) => t(`extensions.perm.${p}.hint` as MessageKey);

function Permissions({ list }: { list: Permission[] }) {
  if (!list.length) return <p className="ext-perms-none">{t('extensions.noPermissions')}</p>;
  return (
    <ul className="ext-perms">
      {list.map((p) => (
        <li key={p}>
          <span className="ext-perm-icon" aria-hidden="true">
            <IconShield size={15} />
          </span>
          <span className="ext-perm-text">
            <span className="ext-perm-label">{permissionLabel(p)}</span>
            <span className="ext-perm-hint">{permissionHint(p)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Settings → Extensions: the Limi extensions this hub ships, what each may read, and installing or
 * removing them on the machine on screen. Daily work happens in the views they add, not here.
 */
export function ExtensionsPage({ api, demo = false, extensions, onChange, onError }: Props) {
  const [installing, setInstalling] = useState<ExtensionState | null>(null);
  const [removing, setRemoving] = useState<ExtensionState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const lang = locale();

  const run = async (id: string, work: () => Promise<ExtensionState | void>) => {
    setBusy(id);
    try {
      const next = await work();
      if (next) onChange(next);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="todos-page ext-page">
      <header className="todos-head">
        <h1 className="todos-title">{t('extensions.title')}</h1>
        <p className="todos-hint">{t('extensions.hint')}</p>
        {demo && <p className="todos-hint ext-demo-note">{t('extensions.demoNote')}</p>}
      </header>

      {extensions === null ? (
        <p className="panel-empty">{t('common.loading')}</p>
      ) : extensions.length === 0 ? (
        <p className="panel-empty">{t('extensions.none')}</p>
      ) : (
        <div className="ext-cards">
          {extensions.map((s) => {
            const m = s.manifest;
            const icon = m.contributes.views?.[0]?.icon;
            const confirm = needsConfirm(s);
            return (
              <article key={m.id} className={`ext-card${s.installed ? ' installed' : ''}`} aria-busy={busy === m.id}>
                <div className="ext-card-head">
                  <span className="ext-card-icon" aria-hidden="true">
                    {icon ? <HostIcon name={icon} size={20} /> : <IconPuzzle size={20} />}
                  </span>
                  <div className="ext-card-titles">
                    <h2 className="ext-card-name">{m.name[lang]}</h2>
                    <div className="ext-card-meta">
                      <span>{t('extensions.version', m.version)}</span>
                      <span>{t('extensions.builtin')}</span>
                      {s.installed && <span className={`ext-card-state${s.enabled ? ' on' : ''}`}>{confirm ? t('extensions.needsConfirm') : s.enabled ? t('extensions.installed') : t('extensions.disabled')}</span>}
                    </div>
                  </div>
                  <div className="ext-card-actions">
                    {!s.installed || confirm ? (
                      <button type="button" className="primary" disabled={busy !== null} onClick={() => setInstalling(s)}>
                        {confirm ? t('extensions.confirmAgain') : t('extensions.install')}
                      </button>
                    ) : (
                      <button type="button" className="ghost" disabled={busy !== null} onClick={() => void run(m.id, () => api.setExtensionEnabled(m.id, !s.enabled))}>
                        {s.enabled ? t('extensions.disable') : t('extensions.enable')}
                      </button>
                    )}
                    {s.installed && (
                      <button type="button" className="ghost ext-remove" disabled={busy !== null} onClick={() => setRemoving(s)}>
                        {t('extensions.uninstall')}
                      </button>
                    )}
                  </div>
                </div>
                <p className="ext-card-desc">{m.description[lang]}</p>
                <div className="ext-card-section">{t('extensions.permissions')}</div>
                <Permissions list={m.permissions} />
              </article>
            );
          })}
        </div>
      )}

      {installing && (
        <Dialog
          title={t('extensions.installTitle', installing.manifest.name[lang])}
          message={t('extensions.installMessage')}
          confirmLabel={t('extensions.install')}
          className="ext-install-dialog"
          onCancel={() => setInstalling(null)}
          onConfirm={() => {
            const s = installing;
            setInstalling(null);
            void run(s.manifest.id, () => api.installExtension(s.manifest.id, s.manifest.permissions));
          }}
        >
          <Permissions list={installing.manifest.permissions} />
          {installing.manifest.permissions.includes('events.summary') && <p className="ext-install-note">{t('extensions.titleNote')}</p>}
        </Dialog>
      )}
      {removing && (
        <Dialog
          title={t('extensions.uninstallTitle', removing.manifest.name[lang])}
          message={t('extensions.uninstallMessage')}
          confirmLabel={t('extensions.uninstall')}
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const s = removing;
            setRemoving(null);
            void run(s.manifest.id, async () => {
              await api.uninstallExtension(s.manifest.id);
              return { ...s, installed: false, enabled: false, granted: [], installedAt: null, updatedAt: null };
            });
          }}
        />
      )}
    </div>
  );
}
