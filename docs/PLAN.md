# 架构与决定

要做什么、做到哪了，看 `TODO.md`。这里只记录结构和已经定下来的事。

## 结构

```
浏览器（手机和桌面同一套代码）
   │  HTTP + SSE，Authorization: Bearer <token>
   ▼
daemon（Node.js，跑在远程主机上）
   ├─ http.ts         路由、鉴权、SSE、静态文件、私有 Unix socket
   ├─ hosts.ts        机器登记、SSH 隧道、健康检查与流式代理
   ├─ threads.ts      线程生命周期、turn、审批、设置
   ├─ store.ts        SQLite：threads、events、sections
   ├─ attachments.ts  图片落盘与校验
   └─ adapters/       每个 agent 一个适配器，对上输出统一事件
```

前端只认统一事件，不知道后面是哪个 agent。能力差异通过 `capabilities` 和模型列表里的字段表达。

## 各 agent 怎么接

| Agent | 方式 | 已验证的能力 |
|---|---|---|
| Claude Code | ACP，`@agentclientprotocol/claude-agent-acp@0.89.0`（stdio JSON-RPC） | 流式、审批、图片输入、`session/list`、`session/load`（回放历史）、`session/fork`、`session/delete`、`session/set_mode`、`session/set_config_option`（模型、强度）、斜杠命令 |
| pi | `pi --mode rpc`（stdin/stdout JSON 行） | 流式、图片输入、`set_model`、`set_thinking_level`、`get_available_models`（含每个模型的强度映射和是否支持图片）、`get_commands`、`clone`、`fork`、`get_messages`；没有审批 |
| Antigravity | `agy --input-format stream-json --output-format stream-json … -p=` | 流式、多轮（一个进程，每行输入一轮）、`--conversation` 恢复、`--model`、SIGINT 停止。输入是 `{"event":"user","message":{"content":…}}`，输出是 `init`、`step_update`、`result`。无界面模式不能询问权限，需要批准的操作会被拒绝；输入只有文字；流里没有思考过程和文件内容 |
| Codex | `codex app-server`（自有 JSON-RPC v2 线程协议，stdio） | 流式、审批（`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`，选项按 `availableDecisions` 生成）、`thread/resume`、`model/list`（含强度和图片输入）、`thread/turns/list`（回放历史）、`thread/fork`、`thread/delete`、`thread/compact/start`（`/compact`）；`turn/start` 携带模型/强度/沙箱覆盖，`thread/tokenUsage/updated` 映射上下文占用 |
| zcode | `zcode app-server`（stdio） | 未接入 |

注意：`@zed-industries/claude-agent-acp` 已停更（0.23.1，模型列表过时），不要用回去。

## 统一事件

| 事件 | 含义 |
|---|---|
| `thread.created` / `thread.updated` | 线程元数据变化 |
| `turn.started` | 用户发出一轮。`text`，可带 `images: [{id, mimeType, size}]` |
| `turn.done` / `turn.error` | 一轮结束。`turn.error` 可带 `code`，界面据此给出说明 |
| `message.delta` | 助手文本增量 |
| `reasoning.delta` | 思考过程增量 |
| `tool.start` / `tool.update` / `tool.end` | 工具调用。`content` 里的 `{type:'diff', path, oldText, newText}` 是文件改动 |
| `approval.request` / `approval.resolved` | 审批。`toolCall.content` 里同样带 diff |
| `plan.updated` | agent 的任务清单 |
| `usage.updated` | 当前上下文占用：`used`、`size`，可带累计费用 `cost`。`used: null` 明确表示占用未知，清除旧读数 |

## 定下来的事

- **多机管理：** 每台机器运行同一个 daemon，主 hub 通过 SSH 隧道接入目标的私有 Unix socket；agent、线程、图片和计划留在目标机器。浏览器一次查看一台机器，切换时整体替换 API 前缀，草稿按机器隔离。目标 daemon 需先安装并启动，不做级联。详见 `multi-host-design.md`。

- **事件日志是唯一真相。** 每个事件有递增的 `seq`，SSE 断线后用 `after=<seq>` 续传。
- **上下文占用和累计用量分开。** Codex 取 `tokenUsage.last.totalTokens`，不能取会话累计的 `total`；pi 取 `contextUsage`，压缩后返回 `tokens: null` 时隐藏旧占用，等下一次响应更新；Claude 和 TRAE 取 ACP 的 `usage_update.used / size`。agy 尚未提供占用数据。前端只消费统一事件，不按 agent 分支；80% 提示只是界面阈值，不表示 agent 已触发自动压缩。
- **读回来按轮次分页。** 文字和思考是一个片段存一条，长轮次有上万条。打开线程只取最新几轮（`events?tail`），更早的从顶部一页页取（`events?before=<seq>`）；一页总是从某一轮的开头开始，单轮再长也整轮给。读回时把同一轮里连续的同类片段合并成首尾两条，存储不变。SSE 续传把游标之后的全部补完再接实时事件，不按页截断。
- **一轮一个工作块。** 一轮里做的事（思考、工具调用、中途说的话）按发生顺序收在一个块里，运行中展开，结束后折成"用时 X · N 步"；块后面的文字才是回答。思考只露最新几行，想完是一行。
- **页面自己发现断线和新版本。** 事件流 40 秒没有任何字节（daemon 每 15 秒发一次 ping）就当它死了重连，回到前台时静默超过 5 秒也立刻重连；线程列表流重连后重新拉一次列表。回到前台或重连时比对 `index.html` 里的入口脚本，不一样就提示"有新版本"。
- **手机键盘。** 键盘不改变页面大小，只是盖住下半部分，浏览器再把剩下的可视区平移到输入框那里。所以 app 整个画在可视区所在的位置：高度取 `visualViewport.height`，位置取 `visualViewport.pageTop`；弹层都在 app 这个盒子里定位，跟着一起到可视区。只跟高度不跟位置，输入框会被顶到屏幕顶部、下面空一片。不要再加 `interactive-widget=resizes-content`。
- **daemon 重启时收尾。** 启动时把还标着"运行中"的线程里没结束的那一轮记为 `turn.error`（`code: interrupted`）。
- **同一个会话，两个入口。** 线程保存 agent 侧的会话 ID。网页和终端操作的是同一份会话；daemon 重启后用这个 ID 恢复。
- **不在 agent 那边留痕迹。** 探测模型和命令用临时进程（pi 加 `--no-session`；Claude 不发消息就不会落盘）。
- **设置按线程保存：** 权限、模型、思考强度。运行中修改会直接作用到会话上，做不到时重启会话并恢复。
  - 权限三档：请求批准 → `default`；帮我批准 → `auto`（没有就退到 `acceptEdits`）；完全访问 → `bypassPermissions`。pi 没有权限模式。
  - 模型列表、每个模型支持的强度、是否能读图片，都从 agent 读，不写死。Claude 要逐个模型探测（约 12 秒），所以 daemon 启动时就在后台做并缓存。
- **审批：** 只接受 agent 给出的选项 ID，其他一律拒绝。取消 turn 时，未决的审批自动按取消处理。
- **图片：** 类型按文件头判断，不信客户端声明；只收 PNG、JPEG、GIF、WebP；每条消息最多 6 张，每张 5 MB；文件存在数据目录，事件里只有引用。
- **斜杠命令按目录取**，因为项目级命令各不相同。
- **Codex 命令走正式协议：** 额度通过 `account/rateLimits/read` 接入统一面板，优先读取多额度池，兼容旧版单池；`/review` 调用 `review/start`，`/mcp` 分页读取服务状态，`/skills` 和技能菜单按当前目录调用 `skills/list`。选择技能后发送结构化 `skill` 输入；查询命令不触发模型推理。终端专用操作仍由 hub 的模型、权限、状态等入口承接，不把未知斜杠命令当普通提示词发送。
- **归档不删东西：** 归档只是从侧边栏隐藏并停掉 agent 进程，随时能恢复。永久删除默认只删 hub 的记录，可以勾选同时删 agent 自己的会话（agent 支持时）。
- **导入：** 只列出白名单目录里、目录还在的会话。历史由 agent 回放后一次写入事件日志（`turn.started` 带 `imported: true`）。导入后的线程继续用原来的会话 ID，一个会话只能对应一个线程。
- **分叉：** agent 复制自己那边的会话，hub 复制事件日志和图片，新线程记下 `forkedFrom`。可以到某一轮为止：两边各有各的轮次编号，所以 hub 先读 agent 的历史（`loadHistory`，每轮带一个 `forkRef`），用和终端同步同一套办法按提问文字对齐，再把那一轮的 `forkRef` 交给 `forkSession`；事件日志只复制到下一轮开始之前。最后一轮等于整个线程，不读历史。
- **斜杠命令分三层：** agent 报的照常列出；agent 只在终端界面里回答、但无界面下另有出路的，由适配器补上（agy 用单次 `agy -p /usage` 运行，pi 用 RPC 的 `compact`、`get_session_stats`，Claude 的 `/cost` 能答只是没列出）；实在没有的（Claude 的 `/status`、`/help`）由 hub 自己做，并把终端里的原名放进搜索关键词。
- **图片按 agent 的能力走：** 能直接收图的发图片本身；agy 只收文字，发文件路径让它自己打开；pi 的纯文本模型在装了 `pi-aux-vision` 后发路径，由它的 `describe_image` 工具交给视觉模型，没装就拦下并提示换模型。
- **排队：** 运行中发的消息排队（内存里，最多 5 条），每轮结束后发下一条；"立即发送"打断当前这轮；按停止则不发，文字退回输入框。
- **未读存在服务器上，** 所以手机上看过，电脑上也算已读。
- **终端（第 10 节）：** 真终端要 PTY，首选 `node-pty`（退路 `script -qfc`）；传输沿用 HTTP + SSE（输出 SSE + base64，输入 POST），不引 WebSocket；终端是临时会话，不写 SQLite，daemon 重启即消失，空闲 30 分钟回收，最多 3 个；起始目录限白名单，之后 cd 不管。
- **agent 做不到的事不假装：** 没有审批的 agent 不显示"请求批准"；agy 因为不能询问而拒绝操作时，`turn.error` 带 `code: permission_refused`，界面提示切到"完全访问"。
- **工作目录白名单：** 只能在 `RAH_WORKDIRS` 列出的目录里建线程。
- **agent 实例（多账号）：** 一个适配器可以起多个实例。实例来自 `data/agents.json`（或 `RAH_AGENTS_JSON` 内联 JSON）：`{ id, adapter, label?, command?, env? }`，adapter 指到 `adapters/` 里的实现，command 不写就继承该适配器的默认。实例 env 合并进它起的所有进程（第二个 Claude 账号带自己的 `CLAUDE_CONFIG_DIR`），所以账号隔离和会话目录隔离都是实例属性。线程的 `agent` 字段存实例 id；内置实例沿用 claude/pi/agy(/traex) 这些名字，老数据零迁移。`GET /api/agents/discover` 扫 PATH 找同类 CLI（前缀匹配且后缀是数字或分隔符，所以 `ping`、`pix` 不算 pi），`POST /api/agents` 添加后立即生效并写回 agents.json。已登录账号的发现：`GET /api/agents/accounts/discover` 让适配器找自己已登录的账号（Claude 扫 `~/.claude*` 目录、逐个 `claude auth status` 验证），已挂到实例上的不列，前端一键链接，差异（找哪里、用什么环境变量）都在适配器里。
- **终端同步：** 打开线程时和每 30 秒（页面可见时）调 `POST /api/threads/:id/sync`，把 agent 那边的历史读回来（临时进程，只读），从头部逐轮和 hub 的事件对齐：hub 独有的取消轮最多跳过 3 条，对不齐就什么都不写。对齐之后多出的轮次整段补进事件日志，带 `fromTerminal` 标记（界面上一个小"终端"徽标），并记下 `externalAt`。`externalAt` 晚于最近一次 hub 轮（`hubTurnAt`）时，网页发送前弹确认——两边同时写同一个会话会乱序；从网页再发一轮后警告自动解除。同步本身有去重锁，轮询和手动拉不会重复导入。

- **交接定位：** 打开交接即由 hub 只读拼接实例 ID、项目 cwd、agent 配置/数据目录、原生 session ID 和实际文件地址，再附日志摘要。原生目录布局由适配器的 `sessionLocation()` 负责，前端不按 agent 名分支。Claude 恢复命令带对应 `CLAUDE_CONFIG_DIR`，不混用同名实例；找不到文件则明确标注，不回退到其他账号。`POST /api/threads/:id/handover-thread` 根据源线程创建独立空线程，沿用原 cwd、worktree 元数据和分区，按目标实例的默认权限初始化；不分叉原生 session，也不创建 worktree 或发送消息。前端先保存按机器/线程隔离的交接草稿，再打开接手线程，用户编辑后发送。复制内容要求接手 agent 使用自己的会话在原 cwd 继续；已有 worktree 通过只读 Git 探测定位，保留分支与未提交改动，不另建目录或要求用户手动开会话。
- **交接关系：** 独立保存 `handover`（来源线程 ID、标题与 agent 快照），与原生 fork 分开。同一机器、同一侧边栏分组内的交接链合为一个可展开入口，点击标题打开最新接手会话，整组按最近活跃时间排序；展开可切换每段会话，折叠时保留其他成员的运行、未读、错误或待批准标记。置顶和手动分区不被自动迁移，活动视图保持逐条显示。会话顶部的「交接记录」支持双向跳转；来源已不在当前列表时保留快照说明。升级只根据首轮中明确的本机交接信息、线程 ID、相同 cwd 和先后创建时间补全旧关系，不按同名标题猜测，也不跨机器猜关联。

## 网络与安全

- TCP HTTP API 验证 token（健康检查除外）；私有 Unix socket 免 token，目录与 socket 权限均为 `0700`。默认位于 `~/.local/state/remote-agent-hub/daemon.sock`，`RAH_SOCKET=off` 可关闭。
- SSH 由 hub 的服务用户发起，使用其 SSH 配置和凭据，要求免交互认证。代理不转发 hub token，不在机器表保存密钥；主 hub token 的权限覆盖所有已添加机器。

- 通过 VPN 访问，HTTP + token。daemon 绑定内网地址，不绑 `0.0.0.0`。
- daemon 相当于远程 shell，只放在可信网络里。
- 因为是 HTTP，不是安全上下文：没有 Service Worker、系统通知和剪贴板 API。复制要用 `execCommand` 降级。

## 扩展机制（设计，未实现）

目标是像 pi 那样：核心页面很简单，新能力（比如 git worktree）和外观（主题、命令怎么展示、甚至一只宠物）都由扩展提供，核心只留挂载点。

- 扩展是一个模块，导出 `activate(api)`。放在配置指定的目录，显式启用。
- 后端挂载点：前置 hook（`thread.beforeCreate`、`turn.beforePrompt`，可改写或拒绝）、通知 hook、审批策略、`/api/ext/<名字>/` 下的路由、带命名空间的存储。
- 前端挂载点：侧边栏区块、线程顶部操作、输入框工具栏、线程菜单。第一版在构建时注册。
- 核心仍然校验工作目录白名单，扩展不能把线程指到白名单之外。

## 开源

- 不写入 token、IP、主机名、个人路径、内部链接。
- 路径来自配置或环境变量。agent 可执行文件从 `PATH` 找，或用 `RAH_*_BIN` 指定。
- 许可证 MIT。

## 第三方扩展审查记录

装进 agent 的第三方代码要先读源码。

| 包 | 结论 |
|---|---|
| `pi-aux-vision@0.5.1` | 可以装。只注册 `describe_image` 工具，当前模型不能看图时才出现；调用视觉模型走 pi 自己的管线和登录，没有自己的网络请求；读文件前确认是真图片；只写自己的配置文件。唯一的命令执行是 Windows 上用 PowerShell 生成测试图 |
| `@z_ai/mcp-server@0.1.5` | 不推荐。没配 `Z_AI_API_KEY` 时会把 `ANTHROPIC_AUTH_TOKEN` 当成 key 发给智谱；模型给什么路径就读什么文件上传，不检查是否是图片 |
| `pi-vision-handoff`、`@getpipher/vision` | 没细审。前者自动转述（不是工具调用）；后者自己直连 `/chat/completions`，还写缓存和审计文件 |

## 全局技能管理

配置菜单中的「技能」按技能列行、按机器列列，单元格显示可见该技能的 agent 实例；手机将机器信息放到技能下方。支持搜索、说明预览、选择来源与目标同步、冲突后显式覆盖，以及删除指定位置的副本。离线机器保留列并显示读取失败。

参考 [Vercel skills](https://github.com/vercel-labs/skills) 的目录映射与文件复制方式，以及 [skills-manager](https://github.com/xingkongliang/skills-manager) 的跨 agent 可见性设计。目录知识只在适配器的 `skillDirs()` 中：实例自己的全局技能目录可作为安装目标，共享目录只作为发现来源。当前覆盖 Claude、Codex、pi、agy；Codex、pi、agy 同时发现共享用户技能。第一期不扫描项目技能、插件内技能，也不从市场下载或自动追踪上游更新。

各机器通过自身 daemon 提供 `/api/skills`、`/detail`、`/export`、`/install`；浏览器通过已有主机代理传递文件载荷。复制全部普通文件并保留可执行位，SHA-256 覆盖路径、完整内容与可执行位。相同内容跳过，不同内容默认不覆盖；先在同目录写完新副本，再替换目标，替换失败恢复旧副本。技能根目录可以是软链接，内部链接只允许指向技能内，循环或指向外部的链接拒绝导出。删除根软链接不删除其指向的技能。

同步限制为 400 个文件、单文件 4 MB、合计 16 MB。校验目录穿越、文件与目录冲突、缺少 `SKILL.md` 及非法编码。技能列表短暂缓存 3 秒，写入后失效。不改 agent 配置或会话；新增技能是否立即可用仍取决于各 agent 的重新加载机制。
