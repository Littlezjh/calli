# 主动行动分级：让大肥鱼敢动手

2026-11-01 · 设计稿。接在 [个人目录文件](personal-files-design.md) 的「提前行动」后面。

## 结论

大肥鱼现在只有 L0「主动发现」：找事、分轻重、早晚报，真正动手要人说「开始」。要更主动，前提是用户亲口总结的两条：**做错了不伤环境（沙盒），并且能回滚（git 标记）**。再加一条：**默认全关，用户主动开启**。分级如下，越往上越要人点头：

| 级别 | 她能做什么 | 在哪做 | 怎么撤回 | 默认 |
|---|---|---|---|---|
| **L0 发现** | 找事、分轻重、早晚报 | 只读 | — | 开（已上线） |
| **L1 准备** | 提前备材料：回复草稿、周报草稿、会前提纲、查背景、一页纸 | 只写个人目录 `matters/<id>-<slug>/artifacts/` | 不用就扔；个人目录 git 留底 | **关**，随总开关打开生效 |
| **L2 沙盒动手** | 代码类事项直接做：修 bug、补测试、改文档 | 独立 worktree，分支 `calli/proactive/<事项ID>`，跑测试 | 合入前「丢弃」；合入后按提交标记一键 revert | **关**；总开关之外还要按仓库单独允许 |
| **L3 对外动作** | 发飞书、推远端、付款、删除 | — | 撤不回 | **永远要人点头**，本设计不改变 |

## 开关（三档：关 / 观察 / 自动）

私人设置新增「主动行动」一节，默认整体关闭，存 hub 设置（不进仓库）：

- `mode: 'off' | 'observe' | 'auto'` 三档开关，默认 `off`。参考 DeepSeek 原型的 Accept mode：没人要求的工作，先只记录「本会做什么」，人看过觉得对再放开。
  - **观察（observe）**：tick 走同样的门控与候选规则，但不建沙盒、不开线程，只写一条 `{ status: 'observed' }` 记录，`summary` 由代码拼（不调模型），例：「会为「会前提纲」提前准备材料：重要，今天截止」「会在 repo 的沙盒里继续「修登录」：你之前开始过这件事」。每条可以点「这条可以」（`approve`，见 API）；看过几条再切到自动。
  - **自动（auto）**：行为与本节其余描述完全一致。
- 迁移：存量 `enabled: true` 读取时迁为 `auto`（已打开的人保持现状）；`false`/缺省迁为 `off`。保存接口兼容旧布尔：`enabled: true` → `observe`（新打开先观察），`false` → `off`；同时给了 `mode` 时以 `mode` 为准。返回值是新形状，带只读兼容字段 `enabled: mode !== 'off'`。
- `repos: string[]` 允许沙盒动手的仓库（绝对路径），逐个添加；为空则 L2 永不运行。保存时校验路径在允许的工作目录内、是 git 仓库。
- 每日上限固定默认：L1 ≤ 5、L2 ≤ 2，先不做界面调节。观察记录不计入每日上限，但计入 60 分钟间隔；同一事项同一 kind 24 小时内只记一条（`approved` 也算）。
- 关掉（`off`）：进行中的回合照常结束，不再开新的主动回合。

## 什么时候动（空闲判定，全部代码判定，不调模型）

同时满足才动，任一不满足就安静待着：

1. 不在安静时段（沿用私人盘点的安静时段，默认 23:00–08:00）。
2. 没有任何运行中的线程。
3. 距上一次主动回合 ≥ 60 分钟。
4. 今日主动回合数未达上限。
5. 候选为空不算错误：不推送、不开线程、不为了显得主动去凑活。

## L1 准备

- **候选**（确定性规则）：未完成、未提议（`proposed`）、重要（`importance: high`）或紧急，两天内有截止或当天的日程信号，尚无「已备好」材料，且无进行中工作线程。
- **动作**：像 `delegate` 一样开一个工作线程（cwd=个人目录），提示词说明这是提前准备：按接续说明产出材料，写入 `matters/<id>-<slug>/artifacts/<名称>.md`，用 `calli todo update` 在接续说明记一句「已备好 X」；不碰外部（不发消息、不改外部仓库）；没值得准备的就安静结束。
- **落盘**：回合结束后 daemon 把新增/变更的 artifacts 提交进个人目录 git（作者 Calli，信息写事项 ID 与操作名）。
- **可见**：桌面该事项摊开层出现「已备好」卡（由 run 记录驱动，列出材料文件名与摘要，不推送打扰）；run 的 `files` 字段存 artifacts 文件的相对路径。

## L2 沙盒动手

- **候选**：事项未完成、无进行中线程，**此前被「开始」过**（有关联工作线程，cwd 在允许列表的仓库内）——首次动手仍由人发起，主动只在已有授权的事项上继续。
- **动作**：
  1. `ProactiveSandbox.prepare(repo, matterId)`：在 `<repo>/.worktrees/` 建 worktree，分支 `calli/proactive/<事项ID>`（已存在则复用）。
  2. 开工作线程，cwd=worktree，提示词：这是沙盒，按接续说明推进；每个提交带 git trailer `Calli-Proactive: <事项ID>`；跑该仓库测试；不推送远端、不动主工作区；结束回复写改动摘要与测试结果。
  3. 回合结束：daemon 收集 diff（文件与行数统计）与 worker 自报的测试结果，写 run 记录，发一条 notice「已在沙盒做好：<事项>」。
  4. **静默试、成了才说**：测试结果明确失败，或没有任何可审的改动 → run 记 `discarded` 并附 `discardReason`（「测试未通过」/「没有可审阅的改动」），不发 notice、不出 ready 卡片。失败判定只看 worker 回复「## 测试结果」段落里的明确失败词（「失败」「failed」「not ok」），判不出来按通过处理，原文留在 `testReport` 里给人看。沙盒 worktree 与分支保留，由人手动「丢弃」。
- **人的决定**：桌面该事项摊开层一张「已在沙盒做好」卡：改动摘要、测试结果、文件数；三个动作：
  - **看改动**：Dialog 按文件列出新增/删除行数，整段 diff 按需再取。
  - **合入**：`merge --no-ff` 回仓库默认分支，合入提交带 trailer；只发生在本地，绝不推远端。
  - **丢弃**：删 worktree 与分支（`ready` 与已有分支的 `failed` 都可丢弃，后者的分支是启动失败留下的残留）。
  - 合入后卡变「已合入」，**撤回**对 HEAD 上该事项所有带 trailer 的提交逐个 revert（新提交，不改历史）。
- **筛选**：桌面可按「大肥鱼主动做的」筛出有主动 run 的事项；已合入的提供撤回。

## 记录与 API

- 设置：hubSetting `personalProactiveSettings { mode: 'off' | 'observe' | 'auto', repos: string[] }`，读取时带只读兼容字段 `enabled: mode !== 'off'`；存量 `enabled` 布尔读取时迁移（`true` → `auto`，`false`/缺省 → `off`）。
- 记录：hubSetting `personalProactiveRuns`，一条 run：
  `{ id, matterId, kind: 'prepare' | 'sandbox', repo?, branch?, threadId, startedAt, endedAt?, status: 'running' | 'observed' | 'approved' | 'ready' | 'merged' | 'discarded' | 'reverted' | 'failed', summary?, discardReason?, testReport?, files?: [{ path, additions, deletions }] }`。重启不丢；`running` 但线程已结束的启动时清为 `failed`。无产出或测试失败的成功回合记 `discarded`（保留限额与间隔审计，不发 notice、不显示 ready）；`observed` 是「本会做什么、为什么」的记录，`approved` 是人看完后的反馈（不触发执行，但使同一候选 24 小时内不再重复记录）；`ready` 或 `merged` 的沙盒不会被自动继续，审阅中的 diff 不会变。
- API（前端契约）：
  - `GET /api/personal/proactive` → `{ settings, runs }`；`?matterId=ID` 只返回该事项的 runs（摊开层按需取）；`?summary=true` → `{ settings, counts }`（事项→run 计数，设置面板与列表层用，不加载全量 runs；observed/approved 计入，discarded 不计）
  - `PUT /api/personal/proactive/settings`（`{ mode?, repos? }`，兼容旧 `enabled?` 布尔，同时给了以 `mode` 为准）→ settings
  - `GET /api/personal/proactive/runs/:id/diff` → `{ files: [{ path, additions, deletions }] }`
  - `POST /api/personal/proactive/runs/:id/merge` / `discard` / `revert` → run
  - `POST /api/personal/proactive/runs/:id/approve` → run（只对 `observed`；其他状态 409「只有观察记录可以标记」，未知 id 404）
  - `GET /api/todos` 每条事项带 `proactiveRunCount`（计数，无 run 时为 0）：列表层用它决定是否显示「大肥鱼主动做的」入口，不为此拉全量 runs。

## 模块与分工

- `packages/daemon/src/proactive-sandbox.ts`（新）：纯 git 层，类 `ProactiveSandbox`：`prepare / changes / merge / discard / revert`，自带 git 执行器，不 import store/http/threads，用临时仓库自测。
- `packages/daemon/src/proactive.ts`（新）+ `scheduler.ts` / `http.ts` / `personal.ts` 接线：三档设置、空闲判定、候选、观察记录、开线程、run 记录、通知、API。
- `packages/web`：三档开关、观察记录与「这条可以」、沙盒卡与三动作、筛选与撤回、i18n 三语、e2e。

## 不做（本轮）

日历空闲判定（接入日程信号后升级）、模型参与的候选判断、每日上限的界面调节、CLI 子命令、推送远端（永远不做）、把「这条可以」变成执行触发（批准只是人的反馈记录，执行仍由切到自动后的 tick 决定）。

## 验收

- 单测：三档设置与迁移（存量 `enabled` 读取、旧布尔写入）、设置校验（路径、git 仓库、工作目录内）、空闲判定每条、候选规则、观察记录（不建线程不建沙盒、summary 内容、不占每日上限、占间隔、24 小时去重、approve 状态流转）、run 生命周期（含沙盒测试失败/无改动静默丢弃且不发 notice）、`ProactiveSandbox` 全操作（合入带 trailer、revert 多提交、丢弃清理、复用已有分支）。
- 假 agent（`test/fixtures/`）：能对 prepare / sandbox 提示词产出可断言的行为。
- e2e（临时 hub + 假 agent）：三档开关、观察记录与「这条可以」、沙盒卡三动作、筛选与撤回。
- 真实浏览器桌面/手机 × 亮/暗截图。
