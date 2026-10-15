import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentInfo, Api } from '../api';
import { copyText } from '../clipboard';
import { compactLabel, durationLabel, numberLabel, type AgentDiagnostic, type UsageReport, type UsageSample } from '../observability';
import { PanelDialog } from './Dialog';
import { Popover } from './Popover';
import { TpmChart } from './TpmChart';
import { IconCheck, IconCopy, IconRefresh, IconChevron } from './icons';

const time = (s: string) => new Date(s).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const cost = (value: UsageSample['cost']) => value ? `${value.estimated ? '估算 ' : ''}${value.currency} ${value.amount.toFixed(4)}` : '未知';
const scope = { request: '模型请求', turn: '整轮汇总', update: '用量增量' };
const status: Record<string, string> = { running: '运行中', done: '完成', error: '出错', cancelled: '已停止' };

function Select({ label, value, options, onPick }: { label: string; value: string; options: Array<{ id: string; label: string }>; onPick: (id: string) => void }) {
  return <Popover label={label} triggerClassName="text-btn obs-select" triggerLabel={label} trigger={<>{options.find(o => o.id === value)?.label ?? label}<IconChevron size={12} open /></>}>
    {close => <><div className="pop-title">{label}</div>{options.map(option => <button key={option.id} type="button" role="menuitemradio" aria-checked={option.id === value} className="pop-item compact" onClick={() => { onPick(option.id); close(); }}>
      <span className="pop-item-text"><span className="pop-item-label">{option.label}</span></span>
      {option.id === value && <span className="pop-item-check"><IconCheck size={16} /></span>}
    </button>)}</>}
  </Popover>;
}

/** Big counts read as 1.03M; hovering shows the exact digits. */
function Count({ values }: { values: Array<number | null | undefined> }) {
  return <strong title={values.map(numberLabel).join(' / ')}>{values.map(compactLabel).join(' / ')}</strong>;
}

function Sample({ sample }: { sample: UsageSample }) {
  return <div className="obs-sample">
    <div className="obs-sample-head"><strong>{scope[sample.scope]}{sample.timing === 'estimated' ? ' · 时间估算' : ''}</strong><span>{sample.model ?? '实际模型未知'}{sample.provider ? ` · ${sample.provider}` : ''}</span></div>
    <dl className="obs-details">
      {[
        ['输入', numberLabel(sample.input)], ['输出', numberLabel(sample.output)], ['总 token', numberLabel(sample.total)],
        ['缓存读取', numberLabel(sample.cacheRead)], ['缓存写入', numberLabel(sample.cacheWrite)], ['推理', numberLabel(sample.reasoning)],
        ['费用', cost(sample.cost)], ['请求耗时', durationLabel(sample.durationMs)], ['首 token 延迟', durationLabel(sample.ttftMs)],
        ['上游账号', sample.account ?? '未报告'],
      ].map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
    </dl>
    {sample.error && <p className="obs-error">{sample.error}</p>}
  </div>;
}

function UsageView({ api, agents }: { api: Api; agents: AgentInfo[] }) {
  const [hours, setHours] = useState('24');
  const [agent, setAgent] = useState('');
  const [metric, setMetric] = useState<'total' | 'output'>('total');
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true, pending = false;
    setReport(null); setError('');
    const read = async () => {
      if (pending) return;
      pending = true;
      try { const data = await api.usageReport(Number(hours), agent); if (alive) { setReport(data); setError(''); } }
      catch { if (alive) setError('统计读取失败，请重试；远程机器可能需要更新服务。'); }
      finally { pending = false; }
    };
    void read();
    const timer = setInterval(() => { if (!document.hidden) void read(); }, 10000);
    return () => { alive = false; clearInterval(timer); };
  }, [api, hours, agent, refresh]);
  return <>
    <div className="obs-toolbar">
      <Select label="统计范围" value={hours} options={[{ id: '1', label: '最近 1 小时' }, { id: '24', label: '最近 24 小时' }, { id: '168', label: '最近 7 天' }]} onPick={setHours} />
      <Select label="统计实例" value={agent} options={[{ id: '', label: '全部实例' }, ...agents.map(a => ({ id: a.id, label: a.label }))]} onPick={setAgent} />
      <Select label="TPM 口径" value={metric} options={[{ id: 'total', label: '合计 token' }, { id: 'output', label: '仅输出 token' }]} onPick={id => setMetric(id as 'total' | 'output')} />
      <button className="icon-btn" aria-label="刷新统计" onClick={() => setRefresh(n => n + 1)}><IconRefresh size={16} /></button>
    </div>
    {error && <p role="alert" className="obs-error">{error}</p>}
    {!report && !error && <p className="panel-empty">正在读取用量…</p>}
    {report && <>
      <div className="obs-metrics">
        <div className="obs-metric obs-primary"><span>{metric === 'output' ? '输出 TPM' : 'TPM'} · 最近 60 秒</span><Count values={[metric === 'output' ? report.outputTpm : report.tpm]} /><small>Token / 分钟 · <span className="obs-token-unit">K 千 · M 百万</span></small></div>
        <div className="obs-metric"><span>总 token</span><Count values={[report.totals.total]} /><small>{report.measuredSamples} 条已报告用量</small></div>
        <div className="obs-metric"><span>输入 / 输出</span><Count values={[report.totals.input, report.totals.output]} /><small>输入包含缓存 token</small></div>
        <div className="obs-metric"><span>缓存读取 / 写入</span><Count values={[report.totals.cacheRead, report.totals.cacheWrite]} /><small>未知字段不计入合计</small></div>
        <div className="obs-metric"><span>已报告费用</span><strong className="obs-cost">{Object.entries(report.costs).map(([currency, v]) => cost({ currency, ...v })).join(' · ') || '未知'}</strong><small>仅含报告费用的记录</small></div>
        <div className="obs-metric"><span>执行轮次 / 出错</span><strong>{report.turns} / {report.errors}</strong><small>一轮可能包含多次模型请求</small></div>
      </div>
      {report.series && <TpmChart series={report.series} agents={agents} metric={metric} empty={metric === 'output' ? !report.outputMeasuredSamples : !report.measuredSamples} />}
      <p className="obs-note">仅统计这台机器启用统计后在 Limi 中执行的用量，不回填历史或分叉副本。TPM 为最近 60 秒的 token 用量；成批上报按两次报告之间的时间平摊，时间分布标为估算，总量来自原生记录。尚未完成的模型请求可能还没有用量，空闲时为 0；未知不代表零。</p>
      <div className="obs-list-title"><h3>最近执行</h3><span>更新于 {time(report.checkedAt)} · 最多 100 轮</span></div>
      {!report.rows.length && <p className="panel-empty">还没有执行记录。发送一条消息后，这里会开始记录。</p>}
      {report.rows.map(row => <details className="obs-turn" key={`${row.threadId}:${row.turnId}`}>
        <summary><div><strong>{row.title}</strong><span>{agents.find(a => a.id === row.agent)?.label ?? row.agent} · {time(row.startedAt)}</span></div><span className={row.status === 'error' ? 'obs-error' : ''}>{status[row.status] ?? row.status}</span></summary>
        <div className="obs-turn-body">
          <p className="obs-note">所选模型：{row.configuredModel ?? '原生默认'} · 实例账号：{row.linkedAccount ?? '未标记'}<br />首段输出等待：{durationLabel(row.firstOutputMs)}（含启动、排队和工具等待，不等于上游首 token 延迟）</p>
          {row.error && <p className="obs-error">{row.error}</p>}
          {row.samples.length ? row.samples.map(s => <Sample key={s.id} sample={s} />) : <p className="obs-note">此轮没有原生用量报告，token、费用和上游请求信息保持未知。</p>}
        </div>
      </details>)}
    </>}
  </>;
}

const states: Record<string, string> = { ready: '模型可读取', missing: 'CLI 不可用', empty: '没有可选模型', authentication: '登录需检查', unsupported: '版本不兼容', timeout: '读取超时', failed: '读取失败' };
const capabilities: Array<[string, string]> = [['resume', '恢复会话'], ['approvals', '审批'], ['images', '图片输入'], ['history', '历史导入'], ['fork', '分叉'], ['compact', '上下文压缩'], ['quota', '套餐额度'], ['coordination', '协作'], ['goal', '原生目标']];

function DiagnosticRow({ api, agent, onResult }: { api: Api; agent: AgentInfo; onResult?: (data: AgentDiagnostic) => void }) {
  const [data, setData] = useState<AgentDiagnostic | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [copied, setCopied] = useState(false);
  const result = useRef(onResult); result.current = onResult;
  useEffect(() => {
    let alive = true;
    setLoading(true); setError(''); setCopied(false);
    void api.agentDiagnostic(agent.id, refresh > 0).then(value => { if (alive) { setData(value); result.current?.(value); } }).catch(() => {
      if (alive) setError('诊断读取失败，请重试；远程机器可能需要更新服务。');
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [api, agent.id, refresh]);
  return <article className="obs-diagnostic">
    <header><div><h3>{agent.label}</h3><span>{loading ? '正在检查…' : data ? states[data.state] ?? data.state : '尚未读取'}</span></div>
      <div className="obs-actions"><button className="icon-btn" aria-label={`刷新 ${agent.label} 诊断`} disabled={loading} onClick={() => setRefresh(n => n + 1)}><IconRefresh size={16} /></button>
        <button className="icon-btn" aria-label={`复制 ${agent.label} 诊断`} disabled={!data} onClick={async () => setCopied(await copyText(JSON.stringify(data, null, 2)))}>{copied ? <IconCheck size={16} /> : <IconCopy size={16} />}</button></div>
    </header>
    {error && <p className="obs-error" role="alert">{error}</p>}
    {data && <>
      <p>{data.message}</p>
      <dl className="obs-details"><div><dt>CLI / 桥接程序版本</dt><dd>{data.version ?? '原生 CLI 未报告'}</dd></div><div><dt>接入协议</dt><dd>{data.protocol ?? '未获取'}</dd></div><div><dt>可选模型</dt><dd>{data.models.length}</dd></div><div><dt>检查时间</dt><dd>{time(data.checkedAt)}</dd></div></dl>
      <div className="obs-capabilities">{capabilities.map(([key, label]) => <span key={key} className={(data.capabilities as unknown as Record<string, unknown>)[key] ? 'supported' : ''}>{label} · {(data.capabilities as unknown as Record<string, unknown>)[key] ? '支持' : '不支持'}</span>)}</div>
      {data.models.length > 0 && <details><summary>查看模型列表</summary><div className="obs-models">{data.models.map(m => <span key={m.id}>{m.label}</span>)}</div></details>}
    </>}
  </article>;
}

export function ObservabilityPanel({ api, agents, initial = 'usage', focusAgent, onResult, onClose }: { api: Api; agents: AgentInfo[]; initial?: 'usage' | 'diagnostics'; focusAgent?: string; onResult?: (data: AgentDiagnostic) => void; onClose: () => void }) {
  const [tab, setTab] = useState(initial);
  const close = useCallback(onClose, [onClose]);
  const ordered = [...agents].sort((a, b) => Number(b.id === focusAgent) - Number(a.id === focusAgent));
  return <PanelDialog title="用量与诊断" className="obs-panel" onClose={close}>
    <nav className="obs-tabs" aria-label="看板内容">{([['usage', '用量统计'], ['diagnostics', 'Agent 诊断']] as const).map(([id, label]) => <button key={id} className={tab === id ? 'selected' : ''} aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}</nav>
    <div className="obs-body">{tab === 'usage' ? <UsageView api={api} agents={agents} /> : <>
      <p className="obs-note">检查本机实例的 CLI、协议和模型列表，不发送模型消息。刷新会重新读取模型；支持项来自适配器声明，实际可用性仍取决于原生 CLI 版本与账号。</p>
      {ordered.map(agent => <DiagnosticRow key={agent.id} api={api} agent={agent} onResult={onResult} />)}
    </>}</div>
  </PanelDialog>;
}
