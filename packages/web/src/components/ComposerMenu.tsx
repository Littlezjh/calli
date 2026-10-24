import { useState } from 'react';
import type { AgentInfo, SlashCommand } from '../api';
import { IconBack, IconBolt, IconCheck, IconChevron, IconList, IconPaperclip, IconSparkle, IconTarget } from './icons';
import { t } from '../i18n';

export type GoalCapability = NonNullable<AgentInfo['capabilities']['goal']>;
export type GoalAction = NonNullable<GoalCapability['actions']>[number];

interface Props {
  commands: SlashCommand[];
  planMode?: { active: boolean; disabled: boolean; onChange: (active: boolean) => void };
  goal?: GoalCapability;
  running: boolean;
  attachTitle: string;
  attachDisabled?: boolean;
  onAttach: () => void;
  onBrowse: (section: 'actions' | 'skills') => void;
  onGoal: (action: GoalAction) => void;
  close: () => void;
}

export const GOAL_LABELS: Record<GoalAction, string> = {
  set: t('goal.set'), show: t('goal.show'), pause: t('goal.pause'), resume: t('goal.resume'), clear: t('goal.clear'),
};
/** A compact phone menu. Browsing opens the composer's full-width command palette. */
export function ComposerMenu({ commands, planMode, goal, running, attachTitle, attachDisabled, onAttach, onBrowse, onGoal, close }: Props) {
  const [page, setPage] = useState<'home' | 'goal'>('home');
  const unknownKinds = commands.some(c => !c.kind);
  const skillTitle = unknownKinds ? t('composerMenu.skillsAndCommands') : t('composerMenu.skills');
  const pick = (action: () => void) => { close(); action(); };

  if (page === 'home') return <div className="composer-menu-list">
    <button type="button" role="menuitem" className="pop-item" title={attachTitle} disabled={attachDisabled} onClick={() => pick(onAttach)}>
      <span className="pop-item-icon"><IconPaperclip size={19} /></span><span className="pop-item-label">{t('composerMenu.attach')}</span>
    </button>
    {(planMode || goal) && <div className="pop-divider" />}
    {planMode && <button type="button" role="menuitemcheckbox" aria-checked={planMode.active} className="pop-item" disabled={planMode.disabled}
      title={planMode.disabled ? t('composerMenu.planAfterTurn') : planMode.active ? t('composerMenu.planOff') : t('composerMenu.planOn')}
      onClick={() => pick(() => planMode.onChange(!planMode.active))}>
      <span className="pop-item-icon"><IconList size={19} /></span>
      <span className="pop-item-text"><span className="pop-item-label">{t('composerMenu.planMode')}</span></span>
      {planMode.active && <span className="pop-item-check"><IconCheck size={16} /></span>}
    </button>}
    {goal && (goal.live ? (
      // Where the goal card can follow the goal, starting one is the only menu entry; the card
      // owns pause/resume/clear. One tap, like plan mode.
      (() => {
        const blocked = running ? t('composerMenu.afterTurn') : planMode?.active ? t('composerMenu.planFirst') : null;
        return <button type="button" role="menuitem" className="pop-item" disabled={!!blocked}
          title={blocked ?? t('composer.goalSetHint')}
          onClick={() => pick(() => onGoal('set'))}>
          <span className="pop-item-icon"><IconTarget size={19} /></span>
          <span className="pop-item-text"><span className="pop-item-label">{t('goal.set')}</span>{blocked && <small className="pop-item-hint">{blocked}</small>}</span>
        </button>;
      })()
    ) : (
      <button type="button" role="menuitem" className="pop-item" onClick={() => setPage('goal')}>
        <span className="pop-item-icon"><IconTarget size={19} /></span>
        <span className="pop-item-text"><span className="pop-item-label">{t('composerMenu.goalMode')}</span></span><IconChevron size={14} />
      </button>
    ))}
    <div className="pop-divider" />
    <button type="button" role="menuitem" className="pop-item" onClick={() => pick(() => onBrowse('actions'))}>
      <span className="pop-item-icon"><IconBolt size={19} /></span><span className="pop-item-text"><span className="pop-item-label">{t('composerMenu.actions')}</span></span><IconChevron size={14} />
    </button>
    <button type="button" role="menuitem" className="pop-item" onClick={() => pick(() => onBrowse('skills'))}>
      <span className="pop-item-icon"><IconSparkle size={19} /></span><span className="pop-item-text"><span className="pop-item-label">{skillTitle}</span></span><IconChevron size={14} />
    </button>
  </div>;

  return <>
    <div className="composer-menu-heading"><button type="button" className="icon-btn" aria-label={t('composerMenu.back')} onClick={() => setPage('home')}><IconBack size={18} /></button><span>{t('composerMenu.goalMode')}</span></div>
    {goal && <div className="composer-menu-list">
      {(goal.actions ?? ['set', ...goal.controls]).map(action => {
        const starts = action === 'set' || action === 'resume';
        const blocked = running ? !goal.controls.some(c => c === action) : starts && planMode?.active;
        return <button type="button" role="menuitem" className="pop-item" key={action} disabled={!!blocked} onClick={() => pick(() => onGoal(action))}>
          <span className="pop-item-text"><span className="pop-item-label">{GOAL_LABELS[action]}</span>{blocked && <small className="pop-item-hint">{running ? t('composerMenu.afterTurn') : t('composerMenu.planFirst')}</small>}</span>
        </button>;
      })}
    </div>}
  </>;
}
