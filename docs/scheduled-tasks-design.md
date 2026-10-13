# 定时任务设计

2026-10-13 · 第一版已实现；时区与错过补跑也已实现（见文末），agent 自建任务见「暂不做」。

给 agent 加定时任务：按 cron 或预设频率，在指定目录、用指定 agent 实例自动发一轮提示词，页面里管理任务和查看运行历史。

## 开源调研

| 项目 | 做法与借鉴 |
|---|---|
| [AionUi](https://github.com/iOfficeAI/AionUi)（管 20+ CLI agent 的开源工作台，最接近我们） | 侧边栏「Scheduled」页。任务 = 名称 + agent/模型 + 工作目录 + 频率（预设：手动/每小时/每天/工作日/每周/自定义）+ 执行模式 + 提示词。执行模式二选一：`new_conversation`（每次新会话）或追加到已有会话让上下文累积。列表有启用开关、下次运行时间、立即运行。5 字段 cron，预设帮你生成。他们的注意事项写得实在：任务只在应用运行时触发；固定会话模式上下文会越堆越乱；提示词带全部工具权限、无人监督地跑 |
| [Trigger.dev](https://trigger.dev) | cron + 时区 + 运行历史面板 + 重试和并发控制。重且偏工作流平台，但「重叠时跳过并记录」和运行历史的状态机（running/done/error/skipped）值得抄 |
| n8n / Activepieces / Windmill | 通用调度平台的共同形态：调度定义（cron/时区/开关）+ 执行列表（每次一条，状态、起止、用时、跳到输出）。agent 只是节点之一，形态比我们重 |
| [nyx-builds/agent-scheduler](https://github.com/nyx-builds/agent-scheduler) | 反过来：作为 MCP 服务器让 **agent 自己**建定时任务（cron、依赖链、重试、优先级队列）。适合做二期：在对话里说「以后每天 9 点跑一遍检查」，agent 调工具自己注册 |
| Hermes Agent / OpenClaw | 内置 cron 引擎跑周期提示词，结果推送 Telegram/Slack。推送我们等 Web Push 方案（见 TODO 第 5 节），先用未读标记 |

各家共同的最小形态，即本方案采纳的：

1. 任务 = agent + 目录 + 提示词 + 频率（预设生成 cron）+ 执行模式（每次新线程 / 固定线程）。
2. 列表：启用开关、下次运行、上次结果、「立即运行」。
3. 运行历史：每次一条（时间、状态、用时），能跳到那次运行的线程。
4. 上一次还没跑完时跳过这一次（记 skipped），不排队叠加。
5. 无人值守先想清楚权限：默认等审批，要全自动就显式选「完全访问」。

## 方案

### 数据模型（SQLite，store.ts）

`schedules` 表：

| 字段 | 说明 |
|---|---|
| id | UUID |
| name | 显示名 |
| agent | 实例 id（同线程的 `agent` 字段） |
| cwd | 工作目录，必须在 workdirs 白名单 |
| prompt | 触发时发送的提示词 |
| cron | 标准 5 字段表达式（分 时 日 月 周），预设由前端生成 |
| mode | `new`（每次新线程）或 `same`（固定线程继续） |
| threadId | `same` 模式绑定的线程；`new` 模式为空。第一次触发时自动创建并记下 |
| permissionMode | 权限档位，默认 `default`；无人值守任务选 `bypassPermissions`。建线程时带上 |
| enabled | 启用开关，默认开 |
| lastRunAt / createdAt / updatedAt | 时间戳 |

`schedule_runs` 表（运行历史，每任务最多留 50 条，旧的删）：

| 字段 | 说明 |
|---|---|
| id | UUID |
| scheduleId | 所属任务 |
| status | `running` / `done` / `error` / `skipped`（上一轮没结束）/ `missed`（daemon 没在跑，启动时补记） |
| threadId / turnId | 这次运行落到哪个线程哪一轮，点击可跳 |
| startedAt / finishedAt | 起止；`error` 时带 message |

线程侧：`ThreadRecord` 加 `schedule: { id, name } | null`（类似 `forkedFrom` 的做法），侧边栏和线程头部显示来源；`turn.started` 事件带 `scheduled: true`，界面像 `fromTerminal` 一样给个小「定时」徽标。

### 调度器（新文件 scheduler.ts）

- daemon 内置，构造时传入 `ThreadManager` 和 `Store`。每 30 秒 tick 一次：算当前分钟，遍历启用中的任务，cron 命中且与 `lastRunAt` 不是同一分钟就触发。
- cron 自写 `cron.ts`：支持 `* , - /`、月和星期的英文缩写、DOM/DOW 同时指定时取并（标准语义）。不引新依赖。时区已支持：任务可存 IANA 时区（空 = daemon 本地），用 `Intl.DateTimeFormat` 取分量（`zonedParts`），匹配、下次触发、错过计数、preview 都按时区，非法时区名返回 400。
- **错过的不补跑。** daemon 启动时，把停机期间本应触发的每次各记一条 `missed`（一个窗口多次命中记一条，标注次数），想补就「立即运行」。AionUi 只在应用开着时触发，我们至少把错过的留痕。
- **重叠跳过。** 触发时该任务上一轮还是 `running` → 记 `skipped`，不发。`same` 模式下同线程并发本来就被 `startTurn` 拒绝；`new` 模式也统一跳过，避免一台机器凌晨堆出一串重复线程。
- **重启收尾。** 启动时把遗留 `running` 的 run 改成 `error`（interrupted），与线程的 `recoverInterrupted` 同一思路。
- daemon 停了任务就停（和 AionUi 一样，daemon 本来就是常驻进程；不做系统 cron 旁路）。

### 触发动作

- `new` 模式：`createThread({ agent, cwd, permissionMode, title: 任务名 +日期 })` + `startTurn({ text: prompt })`。新线程出现在侧边栏，带任务徽标；跑完未读标记照常生效。
- `same` 模式：第一次触发建线程并记 `threadId`；之后每次往该线程发一轮，上下文累积（周报、巡检日志这类）。线程被归档 → run 记 `error` 并在任务上标异常（列表可见）；删除 → 同样标异常。详情页可换绑别的线程或改回 `new`。不自动重建，避免悄悄丢上下文。
- agent 实例被删/不可用：run 记 `error`，任务标异常但保持启用（换机器重启后可能又可用），详情页提示改绑 agent。
- 提示词支持 `{{date}}`（当天 YYYY-MM-DD）占位符，仅此一个，不做成模板系统。

### API（http.ts，REST 风格与现有一致）

```
GET    /api/schedules                 列表（含 nextRunAt、最近一次 run 摘要、异常标记）
POST   /api/schedules                创建（校验 cron、agent、cwd 在白名单、prompt 非空）
PATCH  /api/schedules/:id            改字段 / 启停 / same 模式换绑 threadId
DELETE /api/schedules/:id            删除任务；它建过的线程和事件日志保留（归档语义一致）
POST   /api/schedules/:id/run        立即运行（走同一条触发路径，status 正常记录）
GET    /api/schedules/:id/runs       运行历史（?tail=N，默认 20）
POST   /api/schedules/preview        { cron } → 人话描述 + 下三次触发时间（表单预览，daemon 算）
```

变更通知：`/api/stream`（现在的线程列表流）加推 `schedules.changed`，前端收到就重新拉列表，与线程列表同一套失效逻辑。

### 界面

- 入口：侧边栏「计划」旁边一行「定时任务」（时钟图标，`icons.tsx`），页面版式学计划页：任务卡片列表 + 悬浮「新建任务」。
- 卡片：名称、agent 标志、频率的人话（「每天 09:00」，自定义时显示 cron）、下次运行相对时间、上次结果（成功绿点/失败红点/跳过灰点/进行中转圈）、启用开关；点开进详情。
- 详情/编辑（`Dialog`）：名称、agent 选择器、目录选择（复用 `DirectoryPicker`）、频率（预设：每小时/每天/每工作日/每周几/每月几号/自定义 cron，预设生成 cron，自定义时实时调 preview 显示人话和下三次触发）、执行模式（每次新线程 / 固定线程——可选已有线程或留空首跑自建）、提示词多行、权限档位三选（默认「请求批准」，选「完全访问」时提示无人值守风险）、运行历史列表（每行状态和时间，点跳线程）。
- 异常态：卡片标题旁橙点 + 详情说明（agent 没了 / 线程归档了 / 期间错过 N 次）。
- 手机：整页列表 + 悬浮按钮（学现有计划页），表单 Dialog 上下滚动适配。
- 文案中文、按钮写动作（「新建任务」「立即运行」「删除」）；只用 `styles.css` 变量和现有组件。

### 多机

任务跟着线程所在机器：每台 daemon 跑自己的调度器，存自己的 SQLite。浏览器切机器时 API 前缀整体替换（第 12 节机制），天然生效，主 hub 不做全局聚合。

### 已补充实现（第一版之后）

- **时区字段。** 任务可存 IANA 时区（空 = daemon 本地）：cron 匹配、下次触发、错过计数、preview 都按时区，表单可填时区名（非法即时提示），卡片在非本机时区时显示时区名。
- **错过可选补跑。** 任务可勾「停机错过后，启动时补跑一次」：恢复阶段除记 `missed` 外再补跑一次；默认关闭，行为不变。

### 暂不做（记录取舍）

- **agent 自己建任务（MCP / 对话内注册）。** 需要先决定给 agent 什么入口（涉及「不改 agent 配置」的原则），参考 nyx-builds/agent-scheduler：给个工具让 agent 写 `POST /api/schedules`，界面照常管理。
- **结果推送。** 等第 5 节 Web Push 方案，先用未读标记。

### 测试

- `cron.ts` 单测：匹配、下一次触发、`2月30日`、DOM/DOW 并集、名字缩写、步进列表。
- 假 agent（`test/fixtures/`）即时完成 turn：触发、`new`/`same`、重叠跳过、missed 补记、重启收尾、API 校验（非法 cron、目录出白名单、空提示词）、删除保留线程。
- e2e：建任务 → 立即运行 → 列表出现新线程带徽标。

### 分期

1. **后端**：`cron.ts` + `scheduler.ts` + store 两张表 + API + 单测。
2. **界面**：列表页 + 新建/编辑 Dialog + 运行历史 + 侧边栏入口；桌面和手机、亮色和深色都要看过。
3. **之后**：对话内让 agent 自己建任务、时区、按需补跑。
