import type { VoiceSessionState } from '../voice-session';
import { IconMic, IconMicOff, IconClose } from './icons';
import { t } from '../i18n';

interface Props {
  session: VoiceSessionState;
  onMuteToggle: () => void;
  onStop: () => void;
  onDismissError: () => void;
}

export function VoiceBar({ session, onMuteToggle, onStop, onDismissError }: Props) {
  if (!session.active && !session.error) {
    return null;
  }

  const isError = Boolean(session.error);
  const isConnecting = session.status === 'requesting' || session.status === 'connecting';
  const isConnected = session.status === 'connected';

  let statusLabel = '';
  if (isError) {
    statusLabel = session.error!;
  } else if (isConnecting) {
    statusLabel = t('voice.connecting');
  } else if (isConnected) {
    statusLabel = session.isMuted ? t('voice.muted') : t('voice.live');
  }

  const transcript = session.transcript || (isConnected ? t('voice.listening') : '');

  return (
    <div
      className={`voice-bar${isError ? ' error' : ''}${isConnected ? ' connected' : ''}`}
      role="region"
      aria-label={t('voice.title')}
    >
      <div className="voice-bar-left">
        <span
          className={`voice-status-dot${isConnecting ? ' connecting' : ''}${isConnected ? (session.isMuted ? ' muted' : ' live') : ''}${isError ? ' error' : ''}`}
          aria-hidden="true"
        />
        <span className="voice-status-label" title={statusLabel}>
          {statusLabel}
        </span>
      </div>

      {!isError && (
        <div className="voice-bar-center" title={transcript}>
          <span className={`voice-transcript${session.transcript ? ' text-active' : ''}`}>
            {transcript}
          </span>
        </div>
      )}

      <div className="voice-bar-right">
        {session.active && (
          <button
            type="button"
            className={`voice-btn icon-only${session.isMuted ? ' active-muted' : ''}`}
            aria-label={session.isMuted ? t('voice.unmute') : t('voice.mute')}
            title={session.isMuted ? t('voice.unmute') : t('voice.mute')}
            onClick={onMuteToggle}
          >
            {session.isMuted ? <IconMicOff size={16} /> : <IconMic size={16} />}
          </button>
        )}

        {session.active ? (
          <button
            type="button"
            className="voice-btn stop icon-only"
            aria-label={t('voice.end')}
            title={t('voice.end')}
            onClick={onStop}
          >
            <IconClose size={16} />
          </button>
        ) : (
          <button
            type="button"
            className="voice-btn icon-only"
            aria-label={t('voice.dismiss')}
            title={t('voice.dismiss')}
            onClick={onDismissError}
          >
            <IconClose size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
