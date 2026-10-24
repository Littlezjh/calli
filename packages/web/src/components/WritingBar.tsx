import type { WritingStage, WritingState } from '../api';
import { useIsNarrow } from '../hooks';
import { t } from '../i18n';
import { bodyName, stageLabel, WRITING_STAGES } from '../writing';
import { IconCheck, IconChevron } from './icons';
import { Popover } from './Popover';

interface Props {
  writing: WritingState;
  /** A change is on its way to the daemon: the controls wait for it. */
  busy: boolean;
  onStage: (stage: WritingStage) => void;
  onEnd: () => void;
  onOpen: (file: string) => void;
}

/**
 * Writing mode's band above the input: the stages, with the current one marked, a link to the
 * body, and the way out. On a phone it folds to the body's name and a stage picker.
 */
export function WritingBar({ writing, busy, onStage, onEnd, onOpen }: Props) {
  const narrow = useIsNarrow();
  const name = writing.file ? bodyName(writing.file) : null;
  const body = writing.file && name
    ? <button type="button" className="writing-file" title={writing.file} aria-label={t('writing.openBody', name)} onClick={() => onOpen(writing.file!)}>{narrow && <span className="writing-label">{t('writing.label')}</span>}<span className="writing-file-name">{name}</span></button>
    : <span className="writing-file absent">{narrow && <span className="writing-label">{t('writing.label')}</span>}<span className="writing-file-name">{t('writing.noBody')}</span></span>;

  if (narrow) return (
    <div className="writing-bar compact" role="group" aria-label={t('writing.mode')}>
      {body}
      <Popover label={t('writing.stages')} triggerClassName="writing-stage-pick" triggerTitle={t('writing.stages')} align="end" disabled={busy}
        trigger={<><span>{stageLabel(writing.stage)}</span><IconChevron size={12} open /></>}>
        {close => <>
          {WRITING_STAGES.map(stage => (
            <button type="button" key={stage} role="menuitemradio" aria-checked={stage === writing.stage} className="pop-item"
              onClick={() => { close(); if (stage !== writing.stage) onStage(stage); }}>
              <span className="pop-item-text"><span className="pop-item-label">{stageLabel(stage)}</span></span>
              {stage === writing.stage && <span className="pop-item-check"><IconCheck size={16} /></span>}
            </button>
          ))}
          <div className="pop-divider" />
          <button type="button" role="menuitem" className="pop-item" title={t('writing.off')} onClick={() => { close(); onEnd(); }}>
            <span className="pop-item-text"><span className="pop-item-label">{t('writing.off')}</span></span>
          </button>
        </>}
      </Popover>
    </div>
  );

  return (
    <div className="writing-bar" role="group" aria-label={t('writing.mode')}>
      <span className="writing-label">{t('writing.label')}</span>
      <div className="writing-stages" role="group" aria-label={t('writing.stages')}>
        {WRITING_STAGES.map(stage => (
          <button type="button" key={stage} className={`writing-stage${stage === writing.stage ? ' current' : ''}`} disabled={busy}
            aria-pressed={stage === writing.stage} title={stage === writing.stage ? undefined : t('writing.toStage', stageLabel(stage))}
            onClick={() => { if (stage !== writing.stage) onStage(stage); }}>
            {stageLabel(stage)}
          </button>
        ))}
      </div>
      {body}
      <button type="button" className="writing-end" title={t('writing.off')} disabled={busy} onClick={onEnd}>{t('writing.end')}</button>
    </div>
  );
}
