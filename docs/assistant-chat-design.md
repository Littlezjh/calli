# 助手对话：好聊、看得见、派得动

2026-11-12 · 设计稿。接在 [主动行动](proactive-design.md) 后面。

## 为什么

用户原话：「想和助手直接聊天，不是特别好聊，要点那个特别小的几个字」；「希望这个 agent 聊天更方便、更主动，能给我的其他 coding agent 派活，主动给我 insight 和建议」。

现状：

- 入口两个且都弱：桌面顶部一行小字「和助手聊」（点了跳到助手线程，桌面没了）；右下角「召唤助手」只能说一句话。
- 助手（Router）看不见别的会话在做什么，除非自己去跑 `calli threads`。
- 只有人说「开始 / 交给 agent」且挂在事项上，才能 `calli todo delegate`；不能指定 agent（codex、claude…）和目录，不能派一件没记成事项的活。

参考：Persona 主对话（`docs/assistant/assistant.md`「Live snapshot」「Dispatch tasks」）——每条消息前附实时概况（需要你 / 未读 / 在跑），只带上次以来的变化；派活走 `task_plan`，只读的直接开，会改东西的出「开始」卡；派出去的进度和回执回到对话。Codex 与 Claude Code 的输入框一直在眼前、键盘一键唤起。本设计照这三点做。

## 1. 聊天入口（界面方案由 playground 选）

- 一个对话面板，不跳页：桌面在右侧滑出（桌面内容仍在，可并排看），手机从底部弹出（可拖到全屏）。「和助手聊」与「召唤助手」都打开它，不再两套。
- 入口要大、要一直在：候选见 `docs/design/assistant-chat-playground.html`（A 桌面顶部常驻输入框；B 右下常驻胶囊输入条；C 右侧常驻对话栏）。快捷键 `/` 或 `⌘K` 聚焦输入。
- 面板里是助手线程本身（同一个 thread，不另存一份），沿用现有消息渲染与输入组件。
- 「等你回答」卡片与助手主动说的话在面板顶部可见。

## 2. 实时概况（助手看得见你的会话）

人每次给助手发消息（面板、桌面宠物、飞书都算），daemon 在消息前拼一段 `<calli-context>`，由代码生成，不调模型：

- 时间。
- **需要你**：最后一轮 `[进度]` 是「需要你」的会话（标题、那句话、多久前）；`asking` 的主动行动卡片。
- **在跑**：运行中的会话（标题、agent、跑了多久）。
- **待验收**：最后一轮 `[进度]` 是「待验收」、人还没看过（`unread`）的会话。
- **出错停下**：最后一轮是 `turn.error` 的会话。
- 事项：未完成事项数、逾期数（细节仍用 `calli todo`）。
- 每个会话带 ID，助手需要细节时用现有 `calli threads show ID`。

范围：未归档、3 天内有动静、hub 发起的会话；排除助手自己、`askOnce`、协作成员（由 lead 跟进）、主动行动自己开的线程。每类最多 8 条，超出写「另有 N 个」。

**只带变化**：记住上次发给助手的概况（按会话 ID + 状态 + 那句话），下次只带新增、变化和消失（「已不再需要你：X」）。第一次或超过 6 小时没说话时带全量。概况是材料，不是人的指令，提示词里写明。

## 3. 派活

新命令 `calli dispatch`（只有助手可用）：

```
calli dispatch --agent ID --cwd DIR --task-file FILE [--matter ID] [--title TEXT] [--model ID]
```

- 开一个新会话（`createThread` + `startTurn`），agent 和目录必须在 `calli agents` / 允许的工作目录里；`--matter` 时挂到事项（`linkWorkThread`），并把接续说明拼进任务。
- **授权**：
  - 人在当前这句话里明确要求派（「让 codex 去修 X」「派给 claude 去查 Y」）→ 助手带 `--now`，直接开。daemon 校验：这一轮是人发起的（不是飞书信号、工作线程报告、定时盘点），否则拒绝 `--now`。
  - 其他情况（助手自己想到的）→ 不开会话，写一张「开始」卡：`kind: 'dispatch'` 的主动记录，状态 `asking`，卡上显示 agent、目录、任务摘要，按钮「开始」/「不用」。人点「开始」才开。
- 派出去的会话停下后：沿用现有 Worker 报告通道（`receiveWorkerReport`），由助手转述一句；`[进度]` 是需要你 / 待验收 / 失败时推送。
- 永远不派：推远端、发消息给别人、删除、付款类任务——提示词禁止，卡片「开始」后的任务提示词里也写明。

## 4. 主动 insight（第二步，1–3 落地后做）

每天两次（沿用早晚报时间之后半小时）加事件触发（会话停在「需要你」超过 2 小时、同一仓库两个会话改同一批文件），助手在自己的对话里说 ≤3 条建议，每条带一个动作（派给谁 / 关掉 / 去看看）。说之前按 [主动行动 · 提议前先核对](proactive-design.md) 核对一次。没有值得说的就不说。

## 分工

| 成员 | 范围 |
|---|---|
| claude-magpie | 先做 `docs/design/assistant-chat-playground.html`（三种入口方案可切换，桌面/手机、亮/暗）；人选定后实现对话面板（`packages/web`） |
| codex | daemon：实时概况（`personal-router.ts` 拼接、新文件 `personal-context.ts`）、`calli dispatch`（`personal.ts` 命令、`packages/daemon/bin` 的 CLI）、dispatch 卡片的记录与接口、测试与假 agent |

## 验收

- 单测：概况各类判定、排除项、每类上限、只带变化（新增/变化/消失）、6 小时全量；`dispatch` 参数校验、`--now` 仅限人发起的一轮、卡片「开始」/「不用」、挂事项、派出的会话停下后转述。
- 假 agent：对含 `calli-context` 的消息能断言收到；能调用 `calli dispatch`。
- e2e：面板打开/关闭不跳页，手机底部弹出；派活卡片「开始」。
- 真实浏览器：桌面 1440、手机 390，亮/暗。

## 记录与接口

daemon 接口（2026-11-12）：

- `hubSetting personalContext` 保存 `{ threadId, at, entries, matters: { open, overdue } }`。人发起的回合实际开始时生成概况、同事务存快照；排队尚未开始的消息不消耗变化。更换助手线程、首次交谈或距上次人发起的回合 ≥6 小时全量，否则只带新增、变化和消失。概况不进入消息展示正文；正文、来源和混合批次继续沿用原协议。询问某个会话详情仍用 `calli threads show ID`。
- 概况把运行状态放在旧进度之前；错误轮放进「出错停下」，不会同时放进「需要你」。进度只认当前轮 agent 的报告，不认人手动放置的状态。每类最多 8 条（含消失项），超额以数量表示。时间变化本身不会重复报旧信息。排除主动服务自动创建的 prepare/sandbox 线程；由人开始的 dispatch 工作线程仍可见。
- `turn.started.data.personalOrigin: 'person'` 是 daemon 写入的当前助手轮来源。`say`、直接向助手线程发送和混合队列中的人消息均可生成；信号、工作报告、盘点、定时回合不生成。CLI 请求正文不能设置此标记。`--now` 在校验前后及真正开始工作线程时重查同一个人发起的轮次；排队的人消息不授予当前信号轮权限。daemon 验证来源，是否「明确要求派活」由 Router 提示词约束。
- `calli agents` 在助手的个人凭证域也可用，返回 `{ id, label, available }[]`；不会要求给助手开启协作。`calli dispatch` 仅当前助手线程可用，任务文件由 CLI 读取（支持 `-` 标准输入），传到个人 socket 的命令为 `{ op: 'dispatch', agent, cwd, task, matterId?, title?, model?, now? }`。
- 派活复用 `hubSetting personalProactiveRuns`。一条记录：
  ```ts
  {
    id: string;
    kind: 'dispatch';
    status: 'asking' | 'answered' | 'discarded';
    agent: string;
    cwd: string;            // 解析符号链接后的允许目录
    task: string;           // 完整任务，最多 32000 Unicode 字符
    title: string;          // 可显式给，默认取任务首行前 120 字
    model?: string;
    matterId: string;       // 无事项用空字符串，沿用 advance 的约定
    threadId: string;       // 开始前空字符串，开始后为工作线程 ID
    startedAt: string;      // 提议时间
    endedAt?: string;       // 人作出开始或不用决定的时间，不是工作结束时间
    summary: string;       // 任务前 300 字，用于卡片
  }
  ```
- `GET /api/personal/proactive` → 原有 `{ settings, runs }`；dispatch 也在 runs 中，支持 `?matterId=ID`（`?matterId=` 取无事项卡）。`?summary=true` 继续返回 `{ settings, counts, asking }`；`asking[事项ID]` 计入 dispatch，`asking['']` 是无事项卡数，不能因空 key 漏掉。详情与完整任务按需读取，不放入 summary。
- `POST /api/personal/proactive/runs/:id/start` → 更新后的 run，`status: 'answered'`、`threadId` 指向新会话。只允许 dispatch 的 asking 记录。未知记录 404；已处理、其他 kind、并发开始均 409，响应体为 `{ error: string, run: ProactiveRun, starting?: true }`（其他 409 校验冲突也附当前 run）。只有同一张卡片正在被另一个请求启动时带 `starting: true`，前端读取 `ApiError.details.starting`；agent 不可用、事项已完成、卡片已处理等普通 409 均不带此字段（读取为 undefined），应展示错误，不能误当作正在启动。前端从 `ApiError.details.run` 读取，只有 `kind === 'dispatch' && status === 'answered' && threadId` 才直接打开已开的线程；真正并发且首个请求尚未提交时，`starting === true`、run 仍是 asking、threadId 为空，应保留处理中，不能假定已有线程。开工前重新检查 agent 可用、目录仍被允许、事项已接受且未完成；目录越界 403，参数错误 400，事项不存在 404，事项已完成或 agent 不可用 409。未成功开出回合时保留 asking 可重试，并清理空线程；重复点击不重复派活。
- 「不用」用已有 `POST /api/personal/proactive/runs/:id/dismiss` → `discarded`，不会开会话。`--now` 同样留 dispatch 审计记录，成功直接是 answered。主动开关 off 不阻止人的派活提议与决定；dispatch 不消耗自动准备的冷却间隔。
- 有事项时，run 的 answered、threadId 和 `linkWorkThread` 随首轮一起事务提交，并附事项最新接续说明。无事项也通过 dispatch run 找到回报来源。工作线程停下后，WorkerReports 发送 `{ matterId, threadId, title, stage, summary, question?, pushed?, notified? }` 给助手；`stage: 'progress'` 仅在对话转述，其余 answer/review/blocked 沿用既有提醒与去重规则。取消、重启中断仍不打扰。

参考取舍：Codex 用逐轮结构化上下文与授权信息，Cline 在动作执行时判断授权；本实现把概况、来源、动作决定分别记录，在实际开工时重查，而不把模型提示词里的来源声明当作权限依据。参考：[Codex 协议](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs)、[Cline 授权规则](https://docs.cline.bot/features/auto-approve)。
