# 会话统计读数与线程内轨迹 · 设计

线程右上角新增两个读数（会话统计、Token 用量）和一个轨迹按钮；轨迹面板里新增按真实时间画的时间概览。交互见 `docs/design/session-stats.html`（选「右上角读数」）。本文写清口径、接口和存储；界面部分待第二阶段实现。

## 口径

### Token（只认原生用量）

Token 全部来自 `telemetry_samples` 的原生用量样本，不从上下文、字符数或历史对话推算（与 `observability-design.md` 一致）。样本的 `input` 已按各适配器的归一规则包含缓存读取和缓存写入（pi、Codex、Claude、agy、ACP、zcode 都已核实），因此：

- 缓存命中 = 缓存读取 ÷ 全部输入（`input`）。
- 未缓存输入 = `input` − 缓存读取 − 缓存写入。
- 输出注明「含推理 N」时，N 为原生报告的推理 token。

未知不补零：某个字段在整个线程里没有任何样本报告过，就不显示对应行；部分样本缺失的字段按已有样本求和，不求和的视为未知。没有任何样本报告过 `cacheRead` 时，「缓存命中」整行不显示。整个线程一个有效样本都没有（老线程、导入的轮次、终端轮次）时，Token 读数整个隐藏，弹层写明「N 轮没有用量数据」。

### 计时（native 与 hub 两种来源）

一个「模型段」是一次模型请求占用的时间。样本带有原生 `durationMs` 和 `ttftMs`（pi、zcode）时用原生值：段起点 = `startedAt`，首个输出 = `startedAt + ttftMs`，段终点 = `startedAt + durationMs`，来源记为 `native`。

样本没有原生耗时时（Claude、Codex、agy、ACP 等），由 hub 用自己事件日志的时间计算，来源记为 `hub`：

- 段从轮次开始、或从「所有在跑的工具都结束」的时刻开始，到下一个 `tool.start` 或轮次结束为止。
- 等待 = 段内第一个输出（`message.delta`、`reasoning.delta` 或 `tool.start`）减去段的开始；没有输出时全部算等待。
- 生成 = 段的结束减去第一个输出。

边界情况：

- 段内什么都没发生、时长为零（比如前一个工具结束的时刻和下一个工具开始的时刻相同）不计为段。
- 轮次被取消时，最后一段没有输出就整体算等待。
- 事件日志缺轮次开头（daemon 重启后接着跑）时，从能看到的第一个事件算起，仍标 `hub`。
- 工具运行期间的流式输出不计入任何段（这一版不处理「边跑工具边说话」）。
- Claude 的样本带有 `timing: 'estimated'` 的起止时间，那是轮询批次的边界，不是请求边界，只用于存储时间轴，不用于计时。

hub 算出来的数（等待、生成、输出速度、平均等待）界面上一律加「约」，弹层底部说明来源。工具用时永远由 hub 的工具起止区间算（并集，并行的工具不重复计时），设计稿对它不加「约」。

### 输出速度

输出速度 = 输出 token ÷ 生成时间。只在「该轮有输出 token、该轮生成时间 > 0」的轮次上逐轮成立；会话合计 = 这些轮次的输出总和 ÷ 生成时间总和。任何参与合计的轮次用了 `hub` 计时，读数加「约」。

### 工具用时

每个工具的区间是它的第一个事件到最后一个事件（含所有 update）；区间求并集后求和，并行的工具不重复计时。失败的工具照算（它确实占用了时间）。还在跑的工具按读到的事件时刻算到当前。

## 接口

### GET /api/threads/:id/stats

只返回汇总数字，不做明细。与 `/trace` 一样挂在线程鉴权之下。

```ts
interface ThreadStats {
  threadId: string;
  checkedAt: string;
  /** 有轮次正在跑；数字含它此刻的进度，客户端最快每 3 秒刷新一次。 */
  running: boolean;
  turns: number;                    // 线程的全部轮次
  steps: number;                    // 轨迹步骤合计
  /** 模型与工具用时；一个轮次都没量到时为 null（读数隐藏）。 */
  timing: null | {
    source: 'native' | 'hub';       // 任何参与轮次用了 hub 计时就是 'hub'
    turns: number;                  // 量到的轮次数
    segments: number;               // 模型段数
    waitMs: number;                 // 等待首个 token 合计
    avgWaitMs: number | null;       // 平均等待 = waitMs ÷ segments
    genMs: number;                  // 生成合计
    modelMs: number;                // waitMs + genMs
    toolMs: number;                 // 工具区间并集合计
  };
  /** 原生 token 合计；整条线程一个有效样本都没有时为 null（读数隐藏）。 */
  tokens: null | {
    turnsWithout: number;           // 没有用量数据的轮次（老线程、导入、终端轮次）
    input: number | null;           // 归一输入，含缓存读写
    cacheRead: number | null;
    cacheWrite: number | null;
    output: number | null;
    reasoning: number | null;
    total: number | null;
  };
  tokPerSec: number | null;         // 输出速度；量不到为 null
  tokPerSecApprox: boolean;         // 参与合计的轮次里有 hub 计时
}
```

### 轨迹里的模型段（第二阶段画时间概览用）

`TurnTrace` 增加 `segments`，每个模型段一行：

```ts
interface TraceSegment {
  start: string;                    // 段开始（native 时为请求真实开始）
  firstOutput: string | null;       // 首个输出时刻；还没有输出时为 null
  end: string | null;               // 段结束；轮次还在跑、段未关时为 null
  source: 'native' | 'hub';
  /** 对上的请求的输出 token；对不上时缺省，不显示速度。 */
  outputTokens?: number;
  /** 段里包含的轨迹步骤（1 起始，对应 steps 数组的序号），按步骤顺序。 */
  steps: number[];
}
```

只有 `scope === 'request'` 的样本参与段匹配（样本到达时段还开着就记在这一段，否则记在最近关闭的一段；`update`、`turn` 粒度的样本不对应单次请求，不匹配）。时间概览里每段一横条，等待用 `--border-strong`、生成用 `--muted`；段对不上样本时不显示 tok/s。前端只用这些字段，不按 agent 名字分支。

## 存储

计时按轮次算好一次、存下来，不做每次请求全量扫描：

- 新表 `telemetry_turn_stats`（主键 `(thread_id, turn_id)`，外键级联删除线程）：`timing`（native/hub）、`segments`、`steps`、`wait_ms`、`gen_ms`、`tool_ms`。**只存计时**；token 不落这张表，每次读的时候从 `telemetry_samples` 按线程聚合（主键前缀索引，一条线程只有请求数量级的行）。
- 写入时机：轮次结束时（`turn.done` / `turn.error`，延迟一拍后台写，不阻塞轮次收尾）；daemon 重启错过结束事件、导入的轮次等没写上的，在第一次被读到时补算一次并存下。两条路用同一个纯函数，结果一致。
- 运行中的轮次每次读都现算（只读这一轮自己的事件，不扫全线程），不落库；结束后由上面两条路之一落库。
- 一个轮次的事件只被完整计算一次；之后读数是几次小查询（轮次列表、统计行、样本聚合）。

计算函数在 `trace.ts`（段、步骤归属，随轨迹构建一起得出）和 `turn-stats.ts`（单轮统计、线程汇总，纯函数）；存取在 `telemetry.ts`；读取与补算入口在 `ThreadManager.threadStats`。

## 已知取舍

- 「边跑工具边说话」（某些 agent 在工具运行时继续流式输出）不计时，归入后续版本再看。
- Codex 合并多次调用的用量增量对不上单个模型段，段的输出 token 缺省，轮次合计不受影响。
- 段与工具的横条按事件时刻画，hub 时钟与 agent 原生时间戳之间的小偏差不校正。
