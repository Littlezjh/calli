import { useState } from 'react';
import { t } from '../i18n';
import { IconLock } from './icons';

export function SessionInUseNotice({ onRetry, onFork, onError }: {
  onRetry: () => Promise<unknown>;
  onFork?: () => void;
  onError: (error: unknown) => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    try { await onRetry(); }
    catch (error) { onError(error); }
    finally { setRetrying(false); }
  };
  return <div className="session-in-use-wrap"><div className="session-in-use-notice" role="alert">
    <IconLock size={22} />
    <div className="session-in-use-copy">
      <strong>{t('composer.sessionInUseTitle')}</strong>
      <p>{t('composer.sessionInUseMessage')}</p>
    </div>
    <div className="session-in-use-actions">
      <button type="button" disabled={retrying} aria-busy={retrying} onClick={() => void retry()}>{t('common.retry')}</button>
      {onFork && <button type="button" disabled={retrying} onClick={onFork}>{t('composer.forkSession')}</button>}
    </div>
  </div></div>;
}
