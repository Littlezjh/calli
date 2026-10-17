import { useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../web/src/App';
import { Dialog } from '../../web/src/components/Dialog';
import { IconArrowRight, IconCheck, IconRestore, IconSend, IconStop, IconFiles, IconShield, IconList } from '../../web/src/components/icons';
import type { Theme } from '../../web/src/appearance';
import { ShowcaseApi, type Progress } from './ShowcaseApi';
import { SCENARIOS } from './scenarios';
import '../../web/src/styles.css';
import './showcase.css';

const parentMessage = (message: object) => {
  if (window.parent !== window) window.parent.postMessage(message, window.location.origin);
};
const steps: Record<Progress, string> = {
  ready: '点击发送，开始这段体验', running: '正在展示示例过程', approval: '请在对话里处理审批',
  question: '请在对话里回答问题', completed: '体验完成，可以展开改动或切换任务', stopped: '已停止，可以重新体验',
};

function useProgress(api: ShowcaseApi, id: string | null): Progress {
  return useSyncExternalStore(api.subscribe, () => api.progress(id));
}

function Notice({ id, onInstall }: { id: string | null; onInstall: () => void }) {
  useEffect(() => {
    const scene = SCENARIOS.find(s => s.threadId === id)?.id;
    if (scene) parentMessage({ type: 'limi:scene', scene });
  }, [id]);
  return <div className="demo-bar showcase-notice" role="note">
    <span><strong>引导体验</strong> · 本地模拟</span>
    <button className="showcase-text-button" onClick={onInstall}>开始使用 <IconArrowRight size={14} /></button>
  </div>;
}

function GuidedComposer({ api, id, onRestart }: { api: ShowcaseApi; id: string | null; onRestart: (id: string) => void }) {
  const progress = useProgress(api, id);
  const scenario = SCENARIOS.find(s => s.threadId === id);
  const [error, setError] = useState('');
  useEffect(() => setError(''), [id]);
  const act = async () => {
    if (!scenario) return;
    setError('');
    try {
      if (progress === 'ready') await api.startTurn(scenario.threadId, scenario.prompt);
      else await api.cancel(scenario.threadId);
    } catch (error) { setError(error instanceof Error ? error.message : '暂时无法继续，请重新体验。'); }
  };
  const done = progress === 'completed' || progress === 'stopped';
  return <div className="composer showcase-composer">
    <div className="showcase-guide">
      <span className="showcase-guide-marker">{done ? <IconCheck size={15} /> : '试一试'}</span>
      <span>{scenario ? steps[progress] : '选择一个预置任务，看看 Limi 怎么工作。'}</span>
    </div>
    {scenario ? <div className={`composer-box${progress !== 'ready' ? ' is-sent' : ''}`}>
      <label className="sr-only" htmlFor="guided-prompt">预置任务</label>
      <textarea id="guided-prompt" readOnly value={progress === 'ready' ? scenario.prompt : ''} placeholder={progress === 'ready' ? undefined : '任务已发送'} rows={progress === 'ready' ? 2 : 1} />
      <div className="showcase-composer-bar">
        <span>预置任务</span>
        {done ? <button className="primary" onClick={() => onRestart(scenario.threadId)}><IconRestore size={15} /> 重新体验</button>
          : <button className="primary" onClick={() => void act()} aria-label={progress === 'ready' ? '发送示例任务' : '停止演示'}>
            {progress === 'ready' ? <>发送任务 <IconSend size={16} /></> : <>停止 <IconStop size={15} /></>}
          </button>}
      </div>
    </div> : <div className="showcase-choices">{SCENARIOS.map(s => <button className="ghost" key={s.id} onClick={() => onRestart(s.threadId)}>{s.label}</button>)}</div>}
    {error && <p className="bad" role="alert">{error}</p>}
  </div>;
}

function Walkthrough() {
  const [session, setSession] = useState(() => ({
    api: new ShowcaseApi(), key: 0,
    threadId: SCENARIOS.find(s => s.id === new URLSearchParams(location.search).get('scene'))?.threadId ?? SCENARIOS[0].threadId as string,
  }));
  const [theme, setTheme] = useState<Theme>(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const [installOpen, setInstallOpen] = useState(false);
  useEffect(() => {
    if (installOpen) parentMessage({ type: 'limi:focus' });
  }, [installOpen]);
  useEffect(() => () => session.api.dispose(), [session.api]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== window.parent || window.parent === window) return;
      if (event.data?.type === 'limi:theme' && ['light', 'dark'].includes(event.data.theme)) setTheme(event.data.theme);
    };
    window.addEventListener('message', receive);
    parentMessage({ type: 'limi:ready' });
    return () => window.removeEventListener('message', receive);
  }, []);
  const restart = (threadId: string) => {
    session.api.dispose();
    setSession({ api: new ShowcaseApi(), key: session.key + 1, threadId });
  };
  const install = () => {
    setInstallOpen(false);
    if (window.parent === window) window.location.assign('../#install');
    else parentMessage({ type: 'limi:install' });
  };
  return <>
    <App key={session.key} token="" onToken={() => {}} showcase={{
      api: session.api, initialThreadId: session.threadId, theme,
      notice: id => <Notice id={id} onInstall={() => setInstallOpen(true)} />,
      intro: id => <div className="showcase-intro">
        <div className="showcase-intro-icon">{id === 'demo-scroll-fix' ? <IconShield size={28} /> : id === 'demo-routes' ? <IconList size={28} /> : <IconFiles size={28} />}</div>
        <h2>{id === 'demo-scroll-fix' ? '需要你时，再接手。' : id === 'demo-routes' ? '先聊清楚，再开始。' : '把任务交出去，进展留在眼前。'}</h2>
        <p>{SCENARIOS.find(s => s.threadId === id)?.hint}</p>
        <div className="showcase-intro-steps"><span>发送任务</span><IconArrowRight size={14} /><span>跟进过程</span><IconArrowRight size={14} /><span>{id === 'demo-scroll-fix' ? '处理审批' : id === 'demo-routes' ? '讨论方案' : '查看改动'}</span></div>
      </div>,
      composer: id => <GuidedComposer api={session.api} id={id} onRestart={restart} />,
      onInstall: () => setInstallOpen(true),
    }} />
    {installOpen && <Dialog title="把 Limi 用在自己的项目里" message="这里是预置任务的引导体验。安装 Limi 后，就能连接你自己的 agent、发送任务和管理会话。" confirmLabel="查看安装步骤" onConfirm={install} onCancel={() => setInstallOpen(false)} />}
  </>;
}

createRoot(document.getElementById('root')!).render(<Walkthrough />);
