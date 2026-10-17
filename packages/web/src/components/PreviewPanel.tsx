import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api } from '../api';
import { IconClose, IconExternal, IconRefresh } from './icons';
import { t } from '../i18n';

/**
 * A page an agent wrote, rendered: the file is served from the thread's directory through a
 * short-lived signed URL, and the iframe is sandboxed to scripts only — the page cannot reach the
 * hub's storage or API, open popups, or navigate away. Refresh re-signs and reloads, so it always
 * shows what is on disk right now.
 */

interface Props {
  api: Api;
  threadId: string;
  path: string;
  onClose: () => void;
  onError: (e: unknown) => void;
}

export function PreviewPanel({ api, threadId, path, onClose, onError }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState(0);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const { url: signed } = await api.previewLink(threadId, path);
      if (!alive.current) return;
      setUrl(signed);
      setRefreshedAt(Date.now());
    } catch (e) {
      if (alive.current) onError(e);
    }
  }, [api, threadId, path, onError]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const name = path.split('/').pop() ?? path;

  return (
    <div className="preview-scrim" onClick={onClose}>
      <div className="preview" role="dialog" aria-modal="true" aria-label={t('preview.label', name)} onClick={(e) => e.stopPropagation()}>
        <div className="preview-bar">
          <span className="preview-name" title={path}>
            {name}
          </span>
          <span className="preview-actions">
            <button className="ghost" onClick={() => void load()}>
              <IconRefresh size={14} /> {t('preview.refresh')}
            </button>
            <button className="ghost" onClick={() => url && window.open(url, '_blank', 'noopener,noreferrer')}>
              <IconExternal size={14} /> {t('preview.newTab')}
            </button>
            <button className="ghost" onClick={onClose} aria-label={t('preview.close')}>
              <IconClose size={14} />
            </button>
          </span>
        </div>
        {url ? (
          <iframe
            key={`${url}#${refreshedAt}`}
            className="preview-frame"
            src={url}
            // On the preview port the page has an origin of its own, apart from the app: scripts
            // run, its own assets load same-origin, and the app stays out of reach. Without
            // allow-same-origin the frame would be opaque and the browser would block its CSS.
            sandbox="allow-scripts allow-same-origin"
            title={t('preview.label', name)}
          />
        ) : (
          <div className="preview-loading">{t('preview.opening')}</div>
        )}
      </div>
    </div>
  );
}
