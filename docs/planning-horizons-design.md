# 助手：按时/天/周/月看事，接管已有会话，问题收起来

2026-11-13 · 设计稿。接在 [助手对话](assistant-chat-design.md) 后面。

## 为什么

用户原话：「我后面想在一个 agent 里面完成所有的会话」；「今天要开周会，最紧急的事情是什么？要干哪几件事情？能不能给我找出来？这一周我要干的事情是什么？以小时、天、周、月级别去看」；「（助手首页）把好多东西都弹出来，太丑了」。

现状缺口：

- 助手只能 `dispatch` 新会话，不能往已有会话里接着说，也不能停掉一个会话。
- 事项只有截止时间，没有周目标、月目标；实时概况里没有日程。
- 助手首页把所有「等你回答」卡片整张铺开，每张带输入框和按钮，手机上一屏只看得到问题。

参考：

- Persona：待办按 今天/本周/本月 筛选（逾期始终算入）；主对话里有「Today」卡片，会议从已登录日历实时读；只读任务不需要批准直接开（`docs/assistant/todos.md`「Calendar」「Read-only planned tasks」）。助手用 `agent_send` 往已有会话发话。
- Codex 与 Claude Code：一次只摆一个待处理的批准或提问，其余计数，不并列铺开。

取舍：时间视图用代码拼，不调模型；目标复用事项和 `parentId`，不建新表；会前准备是助手自己的一轮（像早晚报），不另派工作会话，也就不需要新的授权。

## 1. 时/天/周/月

`GET /api/personal/plan?range=hour|day|week|month`，`calli plan [--range day]`（只有助手可用，个人 socket `{ op: 'plan', range }`）。返回：

```ts
interface PersonalPlan {
  range: 'hour' | 'day' | 'week' | 'month';
  from: string; to: string;           // ISO；hour = 现在起 4 小时；day = 今天；week = 本周一到周日；month = 本月
  meetings: { state: 'ok' | 'unavailable' | 'off'; error?: string; items: PlanMeeting[] };
  urgent: PlanTodo[];                  // urgentUntil 未过、逾期、importance high 且在范围内截止
  due: PlanTodo[];                     // 在 [from, to) 截止或跟进的未完成事项（不含 urgent 已列的）
  goals: PlanTodo[];                   // week：本周的周目标；month：本月的月目标及其下的周目标；hour/day：本周的周目标
  needsYou: PlanThread[];              // 同实时概况的「需要你」
  running: PlanThread[];               // 同实时概况的「在跑」
}
interface PlanMeeting { id: string; title: string; start: string; end: string; recurring: boolean; url?: string }
interface PlanTodo { id: string; text: string; dueAt: string | null; importance: string | null; horizon: 'week' | 'month' | null; parentId: string | null; stage: TodoStage | null }
interface PlanThread { id: string; title: string; line: string; at: string }
```

- 会议来自飞书日历（复用 `personal-explore.ts` 的 `calendar +agenda`），按范围缓存 5 分钟。没开飞书是 `off`，读失败是 `unavailable` 并带原因，**不能显示成没有会议**。
- 每类最多 20 条，按时间排序。hour 的会议只取未结束的。
- 周从周一开始，按 hub 时区。

## 2. 周目标和月目标

事项加一列 `horizon: 'week' | 'month' | null`。`calli todo add/update --horizon week|month`，`dueAt` 不给时自动设为本周日 / 月末 23:59。月目标下面可以挂周目标（`parentId`），周目标下面挂当天的事，不新增层级规则以外的东西（目前 `parentId` 只允许一层，月 → 周 是这一层；周目标下的具体事项仍按原规则挂到周目标上）。

谁写：人周一或月初说一句，助手拆成目标并记下；助手自己不定目标。`owner: 'me'` 的规则不变（agent 建的是建议，人接受后生效）。

## 3. 实时概况加「接下来」

`<calli-context>` 加一类「接下来」：未来 4 小时的会议（标题、开始时间）和今天截止但未完成的事项，各最多 5 条。只带变化，规则同其他类。日历读失败时写「日程读取失败」，不写空。

## 4. 接管已有会话

```
calli threads say ID --text-file FILE
calli threads stop ID
```

- 只有助手可用，只能在人发起的一轮里用（同 `dispatch --now` 的 `personalOrigin` 校验）；其他来源一律拒绝，提示「请在对话里问人」。不另开卡片，避免首页再多一类卡。
- 目标必须是 hub 里存在、未归档、不是助手自己的会话。`say` 走排队（会话在跑就排到下一轮），`stop` 等同界面上的停止。
- `say` 之后这一轮停下时，沿用 WorkerReports 回报给助手一次（即使这个会话不是 dispatch 出来的）。
- 永远不做的事同 dispatch：推远端、发消息给别人、删除、付款。

## 5. 会前准备

设置 `prep.enabled`（默认开）、`prep.leadMin`（默认 30）。每 5 分钟看一次日历：

- 对周期会议（`recurring`）和人点过名的会议（`calli prep add EVENT_ID`，存在 hubSetting `personalPrep`），在开始前 `leadMin` 分钟给助手发一轮信号（`kind: 'meeting-prep'`），内容是会议标题、时间、参会人、描述链接。助手按提示词去找相关飞书文档、群聊、会话和事项，在主对话里列出材料清单和「最紧急的三件事」。
- 一个会议只准备一次（按 event id + 开始时间去重，持久化）。
- 人直接问「周会要用的东西帮我找出来」时不走这里，助手本来就能做。

## 6. 界面

### 一条顶栏

手机上原来是三行：全局顶栏「< 助手」、助手自己的标题栏（名字 + 五个入口）、概况条（需要你 / 出错）。名字重复，入口角标和概况数字也重复且口径不一（角标数卡片，概况数事项）。改为：

- 入口放进全局顶栏右侧的玻璃胶囊，不再有第二条标题栏。入口四个：事项、会话、桌面、设置（原「需要你」与「事项」打开同一页，合并）。
- 手机不显示概况条，数字由角标承担：事项角标 = 需要你的事项 + 不挂事项的待回答卡片；会话角标 = 出错数。未知时不显示角标，不显示 0。
- 桌面把概况条放在顶栏入口左边，同一行；「需要你」与手机角标同一口径。

### 等你回答收起来

首页不再把卡片铺满。输入框上方只放一条托盘：

- 收起时一行：「N 个等你回答」+ 最新问题的前一行（截断）+ 展开箭头。只有一个时直接展开。
- 展开后每个问题一行（问题首行；派活、「看起来已完成」才标类型），点一行展开这一条的完整内容和操作；同一时间只展开一条。
- 有选项的问题优先用选项按钮；「其他回答」默认收起，点「其他回答」才出输入框。
- 失败、需要配置等错误仍直接显示，不收起。

### 时/天/周/月

抽屉的「事项」页顶部加分段切换「时 · 天 · 周 · 月」（记住上次选择），下面依次是：会议、紧急、截止、目标、需要你。每段默认 5 条，「另有 N 条」点开。未加载、加载失败、确实为空分开显示。首页起手问题加「今天最紧急的是什么」。

## 分工

| 成员 | 范围 |
|---|---|
| codex | daemon：1–5 全部（`personal-plan.ts` 新文件、`personal.ts` 命令、`personal-context.ts`、`store.ts` 加列、`http.ts` 路由、`bin/calli-personal.mjs`、router 提示词、会前准备循环）、测试、假 agent |
| claude（lead） | web：6（`AssistantPanel.tsx`、`api.ts` 的 plan 类型与请求、`styles.css`、i18n），验收 |

## 验收

- 单测：plan 各范围的边界（周一、月末、时区）、日历 off/unavailable、去重、上限；horizon 默认截止；`threads say/stop` 只在人发起的轮可用、拒绝自己和归档会话、say 后回报一次；会前准备只一次、只对周期或点名会议。
- 真实浏览器：桌面 1440、手机 390，亮/暗；托盘收起/展开、四档切换从加载到稳定不跳。

## 记录与接口

daemon 实现（2026-11-13）：

- `GET /api/personal/plan?range=hour|day|week|month` 返回本稿的 `PersonalPlan`；省略 range 用 day。需要 hub Bearer token，未授权 401（`{ error: "unauthorized" }`），非法 range 400（`{ error: "range must be hour, day, week or month" }`）。日历关闭、CLI 不存在、超时、返回格式错误等都不使整个计划失败：HTTP 200，`meetings.state` 分别为 `off` 或 `unavailable`，后者附 `error`；只有读取成功且确实无日程才是 `ok` 加空 items。
- 私人 socket `/command` 新增 `{ op: 'plan', range? }`、`{ op: 'prep.add', id }`、`{ op: 'threads.say', id, text }`、`{ op: 'threads.stop', id }`，均要求当前助手的个人凭证；普通工作线程 403。CLI 对应 `calli plan [--range day]`、`calli prep add EVENT_ID`、`calli threads say ID --text-file FILE|-`、`calli threads stop ID`。文件由 CLI 读取，say 正文上限 32000 Unicode 字符。
- 时间边界使用 hub 进程本地时区（含 DST）；周从周一零点开始，范围右端不包含。日历复用 `calendar +agenda --as user --format json --start ISO --end ISO`，每个 range 缓存五分钟，并合并并发读取。hour 将查询边界向外取整后按实际的未来四小时过滤，保留已开始且未结束的会议。按 event id + start 去重，取消或已拒绝的会议不列出；接口每类最多 20 条，按时间排序。
- `todos.horizon` 是可空 TEXT 列，现有数据迁移为 null。新增和更新事项接受 `horizon: 'week' | 'month' | null`，CLI 用 `--horizon week|month|none`；给 horizon 且未给 dueAt 时设本周日/月末 23:59:00，显式 dueAt（含 null）优先。现有 owner、rev、建议接受和一层 parentId 约束保持不变。
- 实时概况增加「接下来」，开始助手的人发回合前读取未来四小时日历和当天截止事项，各最多五条。沿用 `personalContext` 快照、提交时确认、六小时全量和变化机制；失败明确写「日程读取失败」，不把上次的会议误报成已消失。关闭明确写「日程未开启」。
- say/stop 使用当前助手活动轮的 `personalOrigin === 'person'`，排队的人消息不授权正在运行的信号轮。实际入队/开工前重查；停止在异步协作检查后重查。未知目标 404，自身 403，归档 409，非人发轮 403 并提示「请在对话里问人」。say 返回 `{ turnId }` 或 `{ queued: true, id }`；stop 返回界面停止同样的 `{ dropped, mentions? }`。内部 `assistantSay` 标记只经 daemon 参数传入，随排队消息带入其 `turn.started`；WorkerReports 只回报这轮一次，即使未 dispatch、未关联事项。取消和重启中断沿用 WorkerReports 的不提醒规则，后续普通回合不继承此标记。
- `calli settings` 包含 prep 域；`calli settings set prep.enabled true|false`、`calli settings set prep.leadMin N` 更新 `personalPrepSettings`，默认 `{ enabled: true, leadMin: 30 }`，提前时间允许 1–1440 整数分钟。现有 scheduler 驱动，每五分钟最多查询一次，并避免并发；周期会议或 `calli prep add` 点名会议在提前窗口内触发。`hubSetting personalPrep` 保存 `{ events: string[], sent: Record<string, string> }`，sent 的 key 是 `JSON.stringify([eventId, startISO])`，值是触发时间；投递失败撤销预留，成功后重启不重复。
- 会前准备沿用助手队列，`TurnPart.kind` 与 `TurnChannel.kind` 新增 `meeting-prep`，展示正文「会前准备 · N 场会议」。信号正文包含标题、起止时间、参会人、描述和可用链接；无 person 来源，不授予接管或直接派活权限；与人消息合并时继续沿用混合批次规则。

参考取舍：参考 [Codex 的逐轮协议](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs)和 [Cline 的逐动作授权](https://docs.cline.bot/features/auto-approve)，沿用 daemon 写入的轮次来源，并在动作实际接收时重查；时间聚合由代码完成，模型只解释优先级和材料。
