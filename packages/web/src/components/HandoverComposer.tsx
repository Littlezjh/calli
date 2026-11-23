import { useState, type ComponentProps, type ReactNode } from 'react';
import type { Api, Thread } from '../api';
import { restoreVideos } from '../videos';
import { t } from '../i18n';
import { Dialog } from './Dialog';
import { Composer } from './Composer';
import { AgentMark, IconClose } from './icons';

type Props = {
  api: Api; thread: Thread; hostId: string | null; mark: ReactNode;
  attachBlocked: string | null; onRefresh: () => void; onError: (error: unknown) => void;
  note: ComponentProps<typeof Composer>['note']; onNotesChange: ComponentProps<typeof Composer>['onNotesChange'];
};

/**
 * The quiet mark at the left of the input while a message is aimed at an earlier segment of the
 * chain: where it goes, and the way back to the latest one.
 */
export function SendTargetMark({ label, title, icon, onBack }: { label: string; title: string; icon?: string; onBack: () => void }) {
  return <span className="send-target" title={title}>
    {icon ? <AgentMark path={icon} size={13} /> : null}
    <span className="send-target-label">{t('handover.chain.sendTo', label)}</span>
    <button type="button" className="send-target-back" aria-label={t('handover.chain.goLatest')} title={t('handover.chain.goLatest')} onClick={onBack}><IconClose size={12} /></button>
  </span>;
}

/** The input for a segment the person is reading, not the one the page is on: a message goes to that segment, in its own session. */
export function HandoverComposer({ api, thread, hostId, mark, attachBlocked, onRefresh, onError, note, onNotesChange }: Props) {
  const [restore, setRestore] = useState<{ text: string; nonce: number; mentions?: import('../api').AgentMention[] } | null>(null);
  const [confirm, setConfirm] = useState<{ resolve: () => void; reject: (error: Error) => void } | null>(null);
  return <>
    <Composer draftKey={hostId ? `host:${hostId}:${thread.id}` : thread.id} running={thread.status === 'running'}
      placeholder={thread.status === 'running' ? t('sideChat.queuePlaceholder') : t('handover.chain.continueShort')}
      header={null} left={null} marker={mark} right={null}
      commands={[]} actions={[]} hiddenCommands={[]} onAction={() => {}} attachBlocked={attachBlocked}
      note={note} onNotesChange={onNotesChange} restore={restore} onError={onError}
      referenceSource={{ api, cwd: thread.cwd, threadId: thread.id }}
      onSend={async (text, images, mentions, videos = [], references = []) => {
        if (thread.terminalActivity) await new Promise<void>((resolve, reject) => setConfirm({ resolve, reject }));
        try {
          await api.startTurn(thread.id, text, images.map(({ data, mimeType }) => ({ data, mimeType })), {
            queue: true, mentions, references, videos: await Promise.all(videos.map(async video => (await api.uploadVideo(thread.id, video.file)).id)),
          });
          onRefresh();
        } catch (error) { onError(error); throw error; }
      }}
      onStop={() => { void api.cancel(thread.id).then(result => { if (result.dropped.length || result.mentions?.length) setRestore({ text: result.dropped.join('\n\n'), mentions: result.mentions, nonce: Date.now() }); onRefresh(); }).catch(onError); }}
      queued={thread.queued ?? []}
      onRemoveQueued={id => { void api.removeQueued(thread.id, id).then(onRefresh).catch(onError); }}
      onEditQueued={async id => { const value = await api.removeQueued(thread.id, id); onRefresh(); return { ...value, videos: await restoreVideos(api, thread.id, value.videos) }; }}
      onSendQueuedNow={id => { void api.sendQueuedNow(thread.id, id).then(onRefresh).catch(onError); }} />
    {confirm && <Dialog title={t('app.terminalBusy')} message={t('app.terminalBusyMessage')} confirmLabel={t('app.sendAnyway')}
      onCancel={() => { confirm.reject(new Error('not sent')); setConfirm(null); }}
      onConfirm={() => { confirm.resolve(); setConfirm(null); }} />}
  </>;
}
