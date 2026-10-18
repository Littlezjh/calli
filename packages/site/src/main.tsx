import './zh';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useAppearance } from '../../web/src/hooks';
import { MODES } from '../../web/src/appearance';
import { copyText } from '../../web/src/clipboard';
import { Popover } from '../../web/src/components/Popover';
import { AgentMark, IconAgents, IconArrowRight, IconCheck, IconComputer, IconCopy, IconGlobe, IconPalette, IconRestore, IconServer, IconShield } from '../../web/src/components/icons';
import { ANTIGRAVITY_ICON, CLAUDE_ICON, CODEX_ICON, PI_ICON } from '../../daemon/src/adapters/icons';
import { SCENARIOS } from './scenarios';
import '../../web/src/styles.css';
import './site.css';

const REPOSITORY = 'https://github.com/maxliux5/limi';
const INSTALL = `git clone https://github.com/maxliux5/limi.git
cd limi
npm install
npm run setup
npm run build
RAH_ENV_FILE=../../.env npm start -w @rah/daemon`;
const agents = [
  { name: 'Codex', icon: CODEX_ICON }, { name: 'Claude Code', icon: CLAUDE_ICON },
  { name: 'pi', icon: PI_ICON }, { name: 'Antigravity', icon: ANTIGRAVITY_ICON },
];

function Home() {
  const [appearance, setAppearance, theme] = useAppearance('limi.site.appearance');
  const frame = useRef<HTMLIFrameElement>(null);
  const frameArea = useRef<HTMLDivElement>(null);
  const [started, setStarted] = useState(false);
  const [active, setActive] = useState<string>('theme');
  const [source, setSource] = useState(() => `./demo/?scene=theme&theme=${theme}`);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [copyStatus, setCopyStatus] = useState('复制命令');
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();
  const sendTheme = () => frame.current?.contentWindow?.postMessage({ type: 'limi:theme', theme }, location.origin);
  useEffect(() => {
    if (started || !frameArea.current) return;
    if (!('IntersectionObserver' in window)) { setStarted(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setStarted(true); observer.disconnect(); }
    }, { threshold: 0.1 });
    observer.observe(frameArea.current);
    return () => observer.disconnect();
  }, [started]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === 'limi:ready') { sendTheme(); setReady(true); setFailed(false); }
      if (event.data?.type === 'limi:scene' && SCENARIOS.some(s => s.id === event.data.scene)) setActive(event.data.scene);
      if (event.data?.type === 'limi:focus') frame.current?.scrollIntoView({ block: 'center' });
      if (event.data?.type === 'limi:install') document.getElementById('install')?.scrollIntoView({ behavior: 'smooth' });
    };
    window.addEventListener('message', receive);
    sendTheme();
    return () => window.removeEventListener('message', receive);
  }, [theme]);
  useEffect(() => {
    if (!started || ready) return;
    const timer = setTimeout(() => setFailed(true), 15_000);
    return () => clearTimeout(timer);
  }, [source, ready, started]);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const loadScene = (scene: string) => {
    setStarted(true); setActive(scene); setReady(false); setFailed(false);
    setSource(`./demo/?scene=${scene}&theme=${theme}&restart=${Date.now()}`);
  };
  const copy = async () => {
    setCopyStatus(await copyText(INSTALL) ? '已复制' : '请选中命令复制');
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopyStatus('复制命令'), 2500);
  };

  return <>
    <a className="site-skip" href="#experience" onClick={() => setStarted(true)}>跳到产品体验</a>
    <header className="site-nav">
      <nav className="site-wrap" aria-label="主导航">
        <a className="site-brand" href="#"><img src="./limi-icon.png" alt="" width="32" height="32" />Limi</a>
        <div className="site-links"><a href="#experience" onClick={() => setStarted(true)}>体验</a><a href="#features">为什么选 Limi</a><a href={REPOSITORY} target="_blank" rel="noopener noreferrer">GitHub <span className="site-outward"><IconArrowRight size={12} /></span></a></div>
        <Popover label="选择外观" triggerLabel="选择外观" triggerClassName="site-theme" trigger={<IconPalette size={18} />} align="end">
          {close => <>{MODES.map(mode => <button key={mode.id} className="pop-item" role="menuitemradio" aria-checked={appearance.mode === mode.id} onClick={() => { setAppearance({ mode: mode.id, palette: 'paper' }); close(); }}><span>{mode.name}</span>{appearance.mode === mode.id && <IconCheck size={15} />}</button>)}</>}
        </Popover>
        <a className="site-button site-button-small" href="#install">开始安装</a>
      </nav>
    </header>

    <main>
      <section className="site-hero site-wrap" aria-labelledby="hero-title">
        <p className="site-eyebrow"><span className="site-status-dot" /> 一个轻巧的 agent 工作台</p>
        <h1 id="hero-title">简单管理<br /><span>你的所有 agent。</span></h1>
        <p className="site-lede"><span>不同的 agent 和机器，都在一个网页里。</span><span>查看进展、继续对话、处理审批，随时接手。</span></p>
        <div className="site-actions"><a className="site-button" href="#experience" onClick={() => setStarted(true)}>立即体验 <IconArrowRight size={17} /></a><a className="site-button site-button-secondary" href="#install">在自己的机器上使用</a></div>
        <p className="site-meta">开源 · 自托管 · 电脑与手机</p>
      </section>

      <section className="site-experience site-wrap" id="experience" aria-labelledby="experience-title">
        <div className="site-section-head"><div><p className="site-eyebrow">先用一下</p><h2 id="experience-title">你的下一个任务，从这里开始。</h2></div><p>真实界面，预置任务。<br />无需账号，也不用安装。</p></div>
        <div className="site-demo-window">
          <div className="site-demo-toolbar">
            <div className="site-demo-tabs" role="group" aria-label="选择体验任务">{SCENARIOS.map((scenario, i) => <button key={scenario.id} aria-pressed={active === scenario.id} onClick={() => loadScene(scenario.id)}><span className="site-step-number">0{i + 1}</span>{scenario.label}</button>)}</div>
            <div className="site-demo-tools"><button title="重新体验" aria-label="重新体验" onClick={() => loadScene(active)}><IconRestore size={17} /></button><a className="site-open-demo" href={`./demo/?scene=${active}&theme=${theme}`} target="_blank" rel="noopener noreferrer" title="在新页面体验" aria-label="在新页面体验"><IconGlobe size={17} /><span>全屏体验</span></a></div>
          </div>
          <div className="site-frame-area" ref={frameArea}>
            {started && <iframe key={source} ref={frame} src={source} title="Limi 产品引导体验" className={ready ? 'is-ready' : ''} onError={() => setFailed(true)} />}
            {!ready && <div className="site-frame-loading" role="status"><img src="./limi-icon.png" alt="" width="56" height="56" /><p>{failed ? '体验区暂时没有加载完成' : started ? '正在准备你的工作台…' : '用一个预置任务，体验 Limi'}</p>{(failed || !started) && <button className="site-button site-button-small" onClick={() => loadScene(active)}>{failed ? '重新加载' : '开始体验'}</button>}</div>}
          </div>
        </div>
        <p className="site-demo-note"><span className="site-status-dot" /> 所有操作都是本地模拟，不会运行真实 agent。<span>想用自己的项目？<a href="#install">开始安装 <IconArrowRight size={13} /></a></span></p>
        <div className="site-agents" aria-label="已支持的 agent">{agents.map(agent => <span key={agent.name}><AgentMark path={agent.icon} size={18} />{agent.name}</span>)}</div>
      </section>

      <section className="site-features site-wrap" id="features" aria-labelledby="features-title">
        <div className="site-section-head"><div><p className="site-eyebrow">少一点管理，多一点专注</p><h2 id="features-title">让日常工作，顺手一点。</h2></div></div>
        <div className="site-feature-grid">
          <article><div className="site-feature-icon"><IconAgents size={24} /></div><h3>一处看清进展</h3><p>哪个任务在运行，哪个在等你审批，哪个已经完成。不同 agent 的会话，放在一起管理。</p><div className="site-feature-detail"><span className="site-task-dot" />修复列表滚动<span className="site-status-label">等待审批</span></div></article>
          <article><div className="site-feature-icon"><IconComputer size={24} /></div><h3>随时接手任务</h3><p>电脑上查看改动，手机上补充要求。agent 在远程主机上工作，你从浏览器进入。</p><div className="site-feature-detail"><IconServer size={16} /><span>远程主机</span><span className="site-connection-line" /><IconGlobe size={16} /><span>你的浏览器</span></div></article>
          <article><div className="site-feature-icon"><IconShield size={24} /></div><h3>少一点干预</h3><p>尽量沿用 agent 原有的配置和工作方式。优先接入原生能力，减少额外的指令与上下文负担。</p><div className="site-feature-detail"><IconCheck size={16} /><span>熟悉的 agent，熟悉的工作方式</span></div></article>
        </div>
      </section>

      <section className="site-principle site-wrap" aria-labelledby="principle-title">
        <div className="site-principle-inner"><div><p className="site-eyebrow">我们想坚持的事</p><h2 id="principle-title">默认简单。<br /><span>按需扩展。</span></h2></div><div className="site-principle-copy"><p>用一个简单的界面，把 agent 和它周边的工具串起来。从已有的技能和 MCP 管理出发，让更多能力按需接入。</p><p className="site-roadmap"><span>规划中</span>统一的扩展入口、BotMux 飞书提醒、LoopX 进度与操作，让工具融入同一个工作台。接入方案仍在验证，功能尚未上线。</p></div></div>
      </section>

      <section className="site-install site-wrap" id="install" aria-labelledby="install-title">
        <div><p className="site-eyebrow">带回自己的工作台</p><h2 id="install-title">你的 agent，<br />现在更好管理了。</h2><p>在运行 agent 的主机上安装 Limi，<br className="site-desktop-break" />然后从电脑或手机的浏览器访问。</p><p className="site-install-requirement">需要 Node.js 22 或更高版本。<br />远程访问请使用 VPN 等可信网络。</p><a className="site-doc-link" href={`${REPOSITORY}#快速开始`} target="_blank" rel="noopener noreferrer">阅读完整安装说明 <IconArrowRight size={16} /></a></div>
        <div className="site-install-guide"><div className="site-code-card"><div className="site-code-head"><span>在主机终端运行</span><button onClick={() => void copy()} aria-live="polite">{copyStatus === '已复制' ? <IconCheck size={14} /> : <IconCopy size={14} />}{copyStatus}</button></div><pre><code>{INSTALL}</code></pre></div>
          <ol className="site-install-steps"><li>在这台主机的浏览器打开 <code>http://127.0.0.1:8787/</code>。</li><li>点击「连接 hub」，粘贴 <code>npm run setup</code> 输出的访问 token。</li><li>手机或另一台电脑使用主机的可达地址，按<a href={`${REPOSITORY}#远程访问`} target="_blank" rel="noopener noreferrer">远程访问说明</a>配置网络后连接。</li></ol>
        </div>
      </section>
    </main>
    <footer className="site-footer site-wrap"><a className="site-brand" href="#"><img src="./limi-icon.png" alt="" width="28" height="28" />Limi</a><span>简单管理你的所有 agent。</span><div><a href={REPOSITORY} target="_blank" rel="noopener noreferrer">查看源码</a><a href={`${REPOSITORY}/blob/main/LICENSE`} target="_blank" rel="noopener noreferrer">MIT 许可</a></div></footer>
  </>;
}

createRoot(document.getElementById('root')!).render(<Home />);
