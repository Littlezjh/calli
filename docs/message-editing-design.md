# 消息编辑：开源调研与首版方案

状态：**首版已实现**，实现范围、证据与未验证项见文末「实现与验证」。界面已在无头 Chromium 的桌面/手机、亮/暗四组合看过；真实 Codex/Claude/TRAE 会话的截断仍只核实了协议与源码。

## 1. 先区分三种「编辑」

1. **只修改显示文字**：旧回复不重新生成，agent 仍记着旧输入。对 coding agent 不成立，不能当作消息编辑。
2. **回退当前会话后重发**：目标消息及其后续不再属于当前历史，修改后重新运行。需要原生回退和多端历史重置；是否回滚文件是另一项决定。
3. **保留原会话，分叉后重发**：新会话只继承目标消息之前的上下文，再发送修改后的内容。原会话与文件不被自动修改。

「点铅笔」只是入口，不能据此推断底层是覆盖、回退还是分叉。Codex 开源 TUI 的结论不等于桌面 App 的交互已核实。

## 2. 其他开源项目怎么做

以下引用固定提交，避免后续主分支变化使结论失去依据。

### Codex：当前会话回退，恢复输入再编辑

源码：

- [`app_backtrack.rs`](https://github.com/openai/codex/blob/af91f6ef2cd66ead278ebe7d5751973eef430aee/codex-rs/tui/src/app_backtrack.rs)：选择旧用户输入，回退到该轮之前，将原输入放回 composer。
- [`app/event_dispatch.rs`](https://github.com/openai/codex/blob/af91f6ef2cd66ead278ebe7d5751973eef430aee/codex-rs/tui/src/app/event_dispatch.rs)：重新读取权威历史，检查历史尾部是否变化，执行回退后刷新本地历史。
- [`protocol/v2/thread.rs`](https://github.com/openai/codex/blob/af91f6ef2cd66ead278ebe7d5751973eef430aee/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)：`thread/revert` 与 `thread/fork` 的参数。

观察：

- 开源 TUI 的编辑走 `thread/revert`，不是默认新建分支。协议明确：只改持久会话历史，**不撤销本地文件改动**。
- 不能独立编辑一轮中途的 steer 输入；只能回退到 turn 边界。进行中的目标、失配的历史和无法安全恢复的附件不能假装可编辑。
- 会恢复输入的附件与结构化提及；不是只把可见字符串复制回来。
- 处理「原生回退已提交，但客户端刷新失败」的不确定状态，避免在过时的历史上继续发送。
- 本机 `codex-cli 0.160.1` 生成的实验 schema 另有 `thread/fork.beforeTurnId`：排除该轮与其后续，不能与 `lastTurnId` 同传。该字段需要 `experimentalApi`。这为非破坏式编辑提供路径，**本轮仅核实 schema 与源码，未调用真实会话验证截断**。

适合借鉴：权威边界校验、结构化输入恢复、失败不丢草稿。暂不照搬：修改原会话的回退语义。

### Open WebUI：编辑后发送在消息树里新增分支

源码：

- [`Messages.svelte`](https://github.com/open-webui/open-webui/blob/91ea4e3421d1d8069f13d4a463fcb5986d94ea60/src/lib/components/chat/Messages.svelte)，`editMessage()`。
- [`UserMessage.svelte`](https://github.com/open-webui/open-webui/blob/91ea4e3421d1d8069f13d4a463fcb5986d94ea60/src/lib/components/chat/Messages/UserMessage.svelte)：行内编辑、附件、取消与发送。
- [`utils/index.ts`](https://github.com/open-webui/open-webui/blob/91ea4e3421d1d8069f13d4a463fcb5986d94ea60/src/lib/utils/index.ts)，`createMessagesList()`。

观察：

- 用户消息「编辑后发送」生成新 ID，与旧消息使用同一个 `parentId`；旧消息及其回复保留，`currentId` 指向新分支。
- 模型输入沿当前节点的父链构造，因此不会把旧消息之后的回复混进新分支。
- 行内 textarea，保留附件并允许移除；Esc 取消，Ctrl/Cmd+Enter 发送。点编辑时不会先删除旧历史。
- 还提供「只保存」原地改文字，以及修改助手回复。它管理的是自己的聊天历史，不能直接照搬到持有原生状态的 coding agent。

适合借鉴：编辑后旧路径仍可访问、行内编辑、取消无副作用。暂不照搬：消息树、每条消息的版本切换、只保存不重发、编辑助手回复。

### OpenCode：暂存回退，支持 redo，默认涉及文件快照

源码：

- [`app/session/revert.ts`](https://github.com/anomalyco/opencode/blob/4d5965762ec5e0d1a0b14630553fc62b51a11fba/packages/app/src/session/revert.ts)。
- [`core/session/revert.ts`](https://github.com/anomalyco/opencode/blob/4d5965762ec5e0d1a0b14630553fc62b51a11fba/packages/core/src/session/revert.ts)。
- [`core/session/session.ts`](https://github.com/anomalyco/opencode/blob/4d5965762ec5e0d1a0b14630553fc62b51a11fba/packages/core/src/session/session.ts)。
- [`app/session/commands/fork-dialog.tsx`](https://github.com/anomalyco/opencode/blob/4d5965762ec5e0d1a0b14630553fc62b51a11fba/packages/app/src/session/commands/fork-dialog.tsx)。

观察：

- 已发送输入的回退先 interrupt，再等待执行收尾，之后 `revert.stage` 并恢复输入与上下文附件。排队但未送达的输入直接撤回，不打断正在执行的任务。
- 暂存回退可 `clear`，恢复被回退部分；新的 prompt 准备成功后才 commit 回退。
- 默认按快照撤销目标之后相关文件，底层也有 `files: false` 路径。这个行为与 Codex 的纯历史回退不同。
- 分叉是独立动作，使用 `session.fork({ before: messageID })`，新会话预填原输入。

适合借鉴：排队与已发送分开、先验证后提交、附件完整恢复。暂不照搬：文件快照管理、自动 interrupt、stage/redo 工作流。

### Cline：截断后重新生成，文件恢复独立可选

依据：

- [`editMessageAndRegenerate.ts`](https://github.com/cline/cline/blob/e9dafbb764d0cb9acb4ef93a956ae72c350b3952/apps/vscode/src/core/controller/task/editMessageAndRegenerate.ts)：接口传递原消息定位、文字、图片、文件与 `restoreWorkspace`；说明为截断后开启新轮。
- [`Checkpoints 文档`](https://github.com/cline/cline/blob/e9dafbb764d0cb9acb4ef93a956ae72c350b3952/docs/core-workflows/checkpoints.mdx)：区分恢复文件、恢复任务、同时恢复二者；消息编辑可结合 Restore All。

本轮读取了入口与文档，未逐层审计 controller 的完整实现。

适合借鉴：**历史回退与文件回退必须分别说明**。暂不照搬：另建 shadow Git 与项目快照。

## 3. 首版产品决定

用户最终选择：**可以在后台记下修改前的记录，但第一版先不展示。**此前的编辑版本分组、查看原对话与返回新路线均退出首版范围，不再要求用户选择底层实现。

**首版只提供原位置编辑并重新生成，界面始终是一条对话。**

例：

```text
编辑前显示：用户 A → 回答 A → 用户 B → 回答 B → 用户 C → 回答 C
编辑后显示：用户 A → 回答 A → 用户 B' → 新回答 B'
后台保留：修改前的记录与原生 session 定位信息；首版没有查看入口
```

- 从 B 开始的旧问答不再进入当前上下文，也不自动重新执行。
- 后台保留修改前记录，不删除原生会话。保留是恢复与排查所需的数据，不作为另一个用户可见会话。
- 侧边栏、活动列表、搜索、导出、通知和看板按当前对话工作，不新增备份线程，不让旧版本参与正常列表或误报未读。
- 不提供「查看原对话」、版本切换、版本列表、编辑组或备份提示。以后真有需求再设计入口，不能为了未来功能先加载或传输旧版本详情。
- 保留当前 Hub 线程入口、标题与工作目录；附件、草稿、交接及协作关系不能因编辑被悄悄换到另一个可见线程。
- 普通「分叉」保持独立线程的现有行为，与编辑分开；编辑备份不伪装成交接关系。
- **文件保持当前状态，不自动回滚。**编辑不能撤销命令、外部请求或已产生的副作用。
- 不支持可靠原生边界的实例明确拒绝，不只改气泡文字，也不偷偷复制全部上下文。

### 底层实现方向

优先使用原生「目标消息之前分叉」：原 session 保留修改前历史，新 session 只继承前缀并发送修改后的输入，不需要另外备份，也不需要再回退原 session。

Hub 需要显式保存当前版本与原生 session 的对应关系、修改前版本及编辑操作记录，不能只换 `agentSessionId` 却沿用旧上下文或假装原生 session ID 没变。用户可见的 Hub 线程入口保持稳定，恢复命令指向当前 native session。

隐藏旧版本不是在前端遮掉几条消息：daemon 的历史分页、终端同步、搜索、导出和重连投影必须一致地读取当前版本。事件日志保留修改事实与旧记录，SSE 序号不回退；编辑成功后通知其他设备重载当前历史，不能在旧投影上继续追加。

具体存储迁移与接口实现后续收敛，但不引入用户可见的版本管理产品，也不为不支持回退的 agent 改其配置或安装定制扩展。

## 4. 首版交互

### 入口与编辑器

- 用户消息旁的铅笔入口。桌面 hover 或键盘 focus 显示；触屏有直接可点入口，不依赖 hover，不抢占文字选择与注释手势。
- 原消息位置展开编辑器，原文预填，不直接覆盖底部正常 composer 的草稿。
- 首版编辑文字，原图片、视频与引用保留；可移除已有附件。新增附件可后续复用 composer 的能力，不在首版复制整套输入框。
- 按钮：**取消 / 发送修改**。Enter 换行，Ctrl/Cmd+Enter 发送；Esc 取消，输入法组合期间不触发发送。
- 编辑器内一行说明：**「从这里重新生成，文件保持当前状态。」**不展示备份或分叉说明，不提供「查看修改前会话」。
- 点击铅笔只读取编辑所需内容，不创建线程、停止 agent 或改变任何历史；取消没有服务端写入。
- 发送中显示忙态，禁止重复点击；失败保留编辑文字、引用和附件，错误直接可见。成功后仍在原对话入口显示修改后的消息与新回答。

### 范围与限制

- 支持用户发起的普通已发送消息，包括可可靠定位的历史消息；不只限制最后一条。
- 不编辑助手回复、协作投递、自动交接摘要、定时任务消息、原生控制命令与语音临时记录。首版不重新执行历史斜杠命令或恢复过期协作对象。
- 来源运行中、等待处理、处于启动/设置切换或自动交接临界状态时，发送修改被拒绝，说明先结束当前操作；不自动打断。
- 编辑期间来源历史变化，需要重新校验并提示刷新；保留用户修改，不悄悄采用旧边界。
- 交接合并视图中的来源段仍只读。首版可要求进入单段视图再编辑，不把前段的修改发给最新接手段。
- 排队消息继续用现有撤回编辑，不变成历史分叉。

## 5. 接口与适配器方案

下面是候选契约，不是本轮已实现的 API。

### 按需读取编辑内容

候选：`GET /api/threads/:id/turns/:turnId/edit`。

返回：

- 用户原文（优先 `displayText`）、已有附件引用与消息工作模式。
- 来源历史版本，用于发送时的乐观并发校验。
- 本轮是否可编辑、明确的拒绝原因；必要时按需验证原生边界。

首屏不探测原生编辑边界，也不读取附件二进制或完整工作记录。打开编辑器后才读取需要的数据；长历史的边界查找尽量使用原生 ID 与分页，不以加载所有工具输出为前提。

### 发送修改

候选：`POST /api/threads/:id/turns/:turnId/edit`。

请求包含修改后的文字、保留的附件 ID、来源版本及防重请求 ID；返回当前线程、更新后的历史版本与新轮次，不返回需要用户打开的新线程。由 daemon 执行整套流程，不让浏览器自行猜「上一轮」再调用多个写接口：

1. 校验身份、目标轮次、来源版本、运行与交接状态、附件归属、模型图片能力、输入非空及消息类型。
2. 找到 **目标用户消息之前** 的可靠原生边界。查不到即失败，绝不降级为复制整个会话。
3. 通过适配器正式接口创建只含目标前缀的新原生 session，保留旧记录与 session 定位。显式记录当前线程的编辑版本，安全提交后更新当前历史与 native session 绑定，不创建可见备份线程或编辑组。
4. 用修改后的可见输入发起新轮。沿用来源当前模型、强度、速度与权限，默认保留被编辑消息的 Plan/Execute 模式；隐藏的进度、能力借用等说明重新生成，不能从旧完整 prompt 原样叠加。
5. 同一防重请求 ID 重试复用同一编辑操作及原生分支，不重复创建 session 或启动模型。

需要区分失败阶段：切换当前历史之前失败，原对话继续显示；原生分支已创建但尚未提交时保留可恢复的操作状态；编辑已提交但重发或网络确认失败时，提供明确错误并能重试同一操作，不把备份显示为第二条会话。不能宣称 Hub 与原生 agent 跨进程原子提交，也不能因网络超时就自动再建一个分支。

### 能力表达

- 前端只认 capability 和统一拒绝原因，不按 agent 名称分支。
- 现有 `forkAt` 表示「某轮结束之后分叉」，不是「任意用户消息之前都能分叉」。不能直接用它作为全部消息可编辑的证明。
- 候选增加 `editMessage`（非破坏式分叉编辑）能力，适配器负责 `forkBefore` 的语义与原生引用；名称和是否扩展现有 fork 参数，在实施时收敛。
- Codex：验证实验 `beforeTurnId`。老版本可在可靠映射到上一轮时复用 `lastTurnId`，无法定位的第一条明确不支持。
- pi：已有 RPC fork 从用户 entry 之前创建副本，需补出目标 entry 的统一引用，验证首轮及压缩后的历史边界。
- Claude：已有 ACP 分叉点是最后保留的消息，需要验证前一轮边界；首轮无前一条时不能假定可得到等价空前缀。SDK 的截断恢复参数不等于 ACP 已暴露原地回退。
- TraeX：本机 app-server schema 也有 `beforeTurnId`、`thread/revert` 与 `thread/rollback`；可优先验证 app-server 的前缀 fork，不再仅按 ACP 的前一条消息推断。
- zcode：本机新协议源码已有原地编辑和纯对话 fork，但当前 Calli 使用旧协议。旧 `session/fork` 可能恢复文件，不直接接入；必须选对纯对话路径并验证消息边界和运行偏好。
- agy：终端有 fork/rewind，当前 headless 协议未核实可调用的控制入口；未验证前不展示已发送消息编辑。排队编辑继续保留。

以上是待验证接入路径，不是这些 agent 的新增支持承诺。

### 本机其他 agent 的能力核对

| Agent 与核对版本 | 回退当前会话 | 分叉到目标前缀 | Calli 当前接入的缺口 |
|---|---|---|---|
| Claude Code 2.1.299；ACP 0.89.0，内含 SDK 0.3.293 | 终端 `/rewind` 有只恢复对话的选项；SDK `resumeSessionAt` 提供截断恢复，但 ACP 的 SDK 配置透传明确拒绝该选项，未找到通用原地回退 RPC | ACP `session/fork` 实际调用 SDK `forkSession({ upToMessageId })`，保留边界消息（inclusive） | 中间消息可研究使用前一轮完整边界；首轮没有之前的边界，需要独立验证，不能直接传空值当空会话 |
| pi 1.1.0 | `/tree` 与 SDK `navigateTree` 能在同一 session 内切分支；当前 RPC 命令枚举没有对应导航/回退命令 | RPC `fork(entryId)` 从用户 entry **之前**复制，返回原输入；RPC `clone` 复制当前分支 | 目标 entry 统一映射、图片/注释恢复、压缩前历史与当前版本绑定需要补齐；不必切换整个适配器到 SDK |
| TRAE CLI 0.209.1 | app-server schema 有 `thread/revert(beforeTurnId)` 与 `thread/rollback(numTurns)`；两者均注明不回滚文件，revert 限 paginated history | 实验 `thread/fork.beforeTurnId` 与普通 `lastTurnId` | 当前 fork 主要使用 ACP；需核实 app-server 与 ACP 会话 ID、首条/中间条及 legacy history 的真实兼容行为 |
| zcode 0.16.9，本机源码与构建产物 | 新协议命令 `editUserQuery` 进行同 session active branch cut + 重发；默认 `workspaceMode: preserve`，只允许最新真实用户问题。core 也有 `/rewind conversation <messageId>` 路径 | 新协议 `forkAssistant` 是纯对话 copy；旧 `session/fork` 经 checkpoint 路径可能恢复文件 | 当前接入旧 NDJSON；需正式桥接新命令/投影，不照搬 checkpoint fork。新命令只能编辑最后一条的约束必须如实表达；本机实现不能推广为所有 zcode 分发版本 |
| agy 1.4.4 | 官方终端说明有 `/rewind`、`/undo` | 官方终端说明有 `/fork`，分配新 session，可能涉及新 workspace | headless 文档明确不支持控制请求，也不能随便把 TUI 斜杠命令塞进 stream-json；尚未核实无界面下等价入口 |

依据：

- Claude 官方 [Checkpointing](https://code.claude.com/docs/en/checkpointing) 与 [Sessions](https://platform.claude.com/docs/en/agent-sdk/sessions)；本机 ACP `dist/fork-session.js`、`dist/acp-agent.js` 与内含 SDK `sdk.d.ts`。
- pi 本机 `docs/sessions.md`、`docs/rpc-commands.md`、RPC 类型声明与 runtime 实现；使用正式 SDK 生成合成历史，再以真实 RPC 验证 fork。
- TRAE 使用安装的 `traex app-server generate-json-schema --experimental`，读取 `ThreadForkParams`、`ThreadRevertParams`、`ThreadRollbackParams`。仅生成 schema，不调用真实会话。
- zcode 本机构建对应源码：`zcode-protocol-v4/commands/handlers/fork-edit-retry.ts`、共享 `command.ts`、旧 `zcode-protocol/server-operations.ts` 与 core `rewind-message.ts` / `workspace-checkpoints.ts`；构建 bundle 中能找到相应实现。只读核对，没有执行 rewind/fork。
- agy 官方 [CLI tips](https://antigravity.google/docs/cli/using/)、[Conversations](https://antigravity.google/docs/cli/conversations/)、[Headless](https://antigravity.google/docs/cli/headless)。不从二进制出现函数名推断 headless 可调用。

### pi 隔离验证与限制

- 通过正式 `SessionManager` API 创建仅含两轮合成问答的测试 session，再启动真实 `pi --mode rpc`，关闭扩展/MCP/工具/发现及启动网络；不提交 prompt，不调用模型。
- 从第二条用户 entry fork 后，`get_messages` 仅有第一轮问答；从第一条用户 entry fork 后，问答为空。两次均返回原输入并得到新 native session ID。
- 原 session 四条问答保留。启动恢复进程会追加一条 `thinking_level_change` 元数据，fork 操作自身不再改源文件；因此只保证本次核实的「旧问答不变」，不宣称恢复探测绝对只读或文件字节从启动前到结束完全不变。
- 验证限合成的两轮无附件、未压缩历史；不等于图片、压缩、扩展钩子与真实模型继续运行都已验收。

## 6. 实施顺序与验收

1. **产品范围已收敛**：原位置编辑与重新生成，后台保留旧记录，首版不展示旧版本、不新增会话入口、不做版本分组；文件不回滚，普通 fork 仍独立。
2. **原生验证**：在隔离的测试会话中验证 Codex 首轮、中间轮、末轮、失败/停止轮与压缩后边界，确认旧 session 不变。再逐个验证其他适配器，能力只对有证据的实例开放。
3. **daemon**：实现目标边界、按需读取、防重、失败恢复与附件引用；假 agent 增加对应协议与截断验证。特别验证 agent 看到的上下文，不仅检查网页少了几条消息。
4. **界面**：行内编辑、草稿隔离、忙态与失败恢复；中英日文同时补齐。
5. **回归**：
   - 第一条、中间条、最后一条；重复文字的两轮不能定位错。
   - 旧问答后台保留，当前上下文不包含旧目标及后续；同一线程入口刷新、分页、搜索和导出一致。旧版本不出现在侧边栏、活动、看板或通知中。
   - 图片、视频、注释、纯附件输入、附件失效与来源归属校验。
   - 运行/审批/启动/设置切换拒绝，终端同步改变历史，多设备同时编辑与网络重试。
   - 交接单段归属、协作消息不可编辑、不支持实例不假装支持。
   - 桌面和手机尺寸、亮色和深色在真实浏览器检查；长文字、键盘、焦点、输入法、取消及原 composer 草稿保留。
6. 实施后执行 `npm run typecheck && npm test && npm run build`，记录真实原生验证、假 agent 测试与浏览器验证的各自范围。

## 7. 实现与验证（首版）

- 接口：`POST /api/threads/:id/turns/:turnId/edit`，请求 `{ text, images, videos, revision, requestId }`，返回 `{ turnId, revision }`。编辑前读到的历史版本用 `GET /api/threads/:id/history?head=1` 的 `snapshotSeq`。
- 适配器：`capabilities.editMessage` 与 `HistoryTurn.forkBeforeRef`；`forkBeforeSession()` 负责「复制到某轮之前」，`forkSession()` 仍用于「复制到某轮之后」。已开：pi、Codex、TRAE（走 app-server 的 `beforeTurnId`）、Claude。agy、zcode 暂不开。
- 存储：`message_edits` 记录请求、来源版本、来源/新原生 session 与状态；`edited_events` 原样保存被移出当前对话的事件；`event_sequences` 让 `seq` 只增不减，已打开页面的 SSE 游标不会因回退而重复。
- 前端：`ThreadView` 里用户消息的铅笔与行内编辑框；`thread.historyChanged` 让页面重新读取历史；编辑只在当前线程内进行，合并交接视图和来源段不提供编辑。
- 验证：
  - daemon：`api.test.ts` 覆盖首条、中间条、旧轮次移出当前历史与搜索、同一请求 ID 重试、过期版本、无能力实例拒绝。
  - E2E：`message-edit.spec.mjs`（真实 daemon + 假 agent）覆盖首条编辑、中间条编辑后前后边界、刷新后仍是当前对话、过期页面被拒绝。
  - 浏览器：桌面 1400×900 与手机 390×844，亮色与深色四组合，检查编辑框不横向溢出、取消/发送按钮可见、发送后回到一条对话。
  - 未验证：实体手机；真实 Codex/Claude/TRAE 会话截断只核实了协议与源码，未用真实会话跑完整编辑。

## 8. 首版之外与待实施事项

**旧版本可以后台保存，但第一版先不展示。**这是用户已选择的产品范围，不再反复询问是否增加查看入口。

首版之外：查看修改前对话、恢复旧版本、版本列表、版本分组、文件回滚。

待实施：当前历史与 native session 绑定的持久化、跨设备投影刷新、失败与防重恢复、既有交接/协作归属，以及各适配器能编辑首条、中间条还是仅末条的真实能力范围。不能为统一界面忽略原生限制。
