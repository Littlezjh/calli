import { useState } from 'react';
import { Dialog } from './Dialog';
import { t } from '../i18n';
import './fork-subchat.css';

interface Props {
  worktreeAvailable: boolean;
  onConfirm: (opts: { forkTag: string; firstMessage: string; worktree: boolean }) => void;
  onCancel: () => void;
}

/** Light one-step card to fork a grouped sub-conversation in the current directory. */
export function ForkSubchatDialog({ worktreeAvailable, onConfirm, onCancel }: Props) {
  const [forkTag, setForkTag] = useState('');
  const [firstMessage, setFirstMessage] = useState('');
  const hasMessage = firstMessage.trim().length > 0;

  return (
    <Dialog
      className="fork-subchat-dialog"
      title={t('actions.forkSubchatTitle')}
      message={t('actions.forkSubchatMessage')}
      options={worktreeAvailable ? [{ label: t('actions.forkSubchatWorktree'), hint: t('actions.forkSubchatWorktreeHint') }] : []}
      confirmLabel={hasMessage ? t('actions.forkSubchatBackground') : t('actions.forkSubchatEnter')}
      onConfirm={(_, [worktree]) => onConfirm({ forkTag: forkTag.trim(), firstMessage: firstMessage.trim(), worktree: Boolean(worktree) })}
      onCancel={onCancel}
    >
      <div className="fork-subchat-fields">
        <label className="fork-subchat-field">
          <span>{t('actions.forkTagLabel')}</span>
          <input
            type="text"
            maxLength={40}
            autoFocus
            value={forkTag}
            placeholder={t('actions.forkTagPlaceholder')}
            onChange={(e) => setForkTag(e.target.value)}
          />
        </label>
        <label className="fork-subchat-field">
          <span>{t('actions.forkFirstMessageLabel')}</span>
          <textarea
            rows={2}
            value={firstMessage}
            placeholder={t('actions.forkFirstMessagePlaceholder')}
            onChange={(e) => setFirstMessage(e.target.value)}
          />
        </label>
      </div>
    </Dialog>
  );
}
