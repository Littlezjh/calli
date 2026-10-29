# zcode 精简接入（配置与协议方案）

## 范围

不修改 zcode 源码、不安装定制 CLI、不改用户全局配置。calli 启动原版 `zcode app-server`，通过已有协议关闭记忆、限制工具与工作流。

精简不是无状态：保留原生会话历史、恢复、模型选择、思考档位、取消、压缩。自动跨会话记忆与会话历史分开。旧历史已经包含的记忆文字不会被删除。

## adapter 已实施的设置

| 功能 | 现有入口 | 行为与边界 |
|---|---|---|
| 自动记忆 | `session/requestRuntimePreferences` | 创建/恢复及执行前回复 `memoryEnabled: false`；旧服务不请求偏好则拒绝继续。主记忆读取和提取均受此总开关约束 |
| 工具范围 | create/resume 的 `toolAllowlist` | 允许 Read、Write、Edit、Bash、Grep、Glob，以及原生交互工具 AskUserQuestion、EnterPlanMode、ExitPlanMode；以实际 CLI 注册工具为准 |
| 工作流/闲时任务 | create/resume 的 `dynamicWorkflowEnabled`、`offPeakToolEnabled` | 均为 false；不注册相应调用工具 |
| 额外搜索增强 | 运行时偏好的 `nativeSearchEnhancementsEnabled` | false；基础 Shell 搜索仍可用 |
| 自动回答提问 | `askUserQuestionAutoResolutionEnabled` | false；通过 `interaction/requestUserInput` 把问题交给网页，不代替用户作答 |
| 工作模式 | create 的 mode、`session/setMode` | plan/build；原生计划审批交给网页，批准后按原生 `session.updated` 的 `planEnabled` 同步模式，保留同一会话 |
| 自动标题 | create 的 `titleGenerationEnabled` | 新会话为 false；resume 协议没有同等字段，不承诺所有历史会话完全无标题请求 |
| 会话 MCP | create/resume 的 `mcpServers: []` | 空数组会被本机 CLI 当作未覆盖；用户配置和插件 MCP 仍可能初始化，只有模型调用面受工具白名单限制 |
| 命令 | adapter 的命令入口 | `/compact`、`/help`、`/session`、`/usage`；查询命令本地处理，不提交模型；不展开自定义命令或工作流 |
| 原生长期目标 | `session/goal` 与 snapshot 的 target | 接入原生目标及续跑；活跃目标不可进入计划模式，需先暂停目标 |

模型实际看到的工具范围受白名单限制，但 Shell 仍是通用执行能力，白名单不是操作系统沙箱。

**权限差异：** 本机版本把 `toolAllowlist` 同时投影到 permission.allowedTools，基础工具会被免审批。adapter 不提供三档权限选择，执行时使用 build 模式，计划时使用 plan 模式，继续处理 zcode 真正发出的审批请求（例如用户已有的更高优先级规则）。不能把这一接入显示为“每次操作请求批准”。真实 CLI + 本地模拟模型已验证：计划模式下 Write 仍被原生约束阻止，ExitPlanMode 仍需显式批准。

## 仍依赖 zcode 配置的功能

Skills、插件、Hooks、MCP 自动加载与原生子代理模块并没有被会话协议完整关闭。若要对整个 zcode 关闭这些功能，可在备份后把下面字段**合并**到 `~/.zcode/cli/config.json`，保留原来的模型、账号和其他字段：

```json
{
  "features": {
    "compact": true,
    "memory": false,
    "subagent": false,
    "skill": false,
    "mcp": false
  },
  "memory": { "use": false },
  "skills": { "enabled": false },
  "plugins": { "enabled": false },
  "hooks": { "enabled": false }
}
```

项目 `zcode.json`、`.zcode/config.json` 的优先级可能高于用户配置，需检查项目是否重新开启。以上设置控制功能使用，不承诺完全跳过目录扫描或内部模块初始化。自动 checkpoint/rewind 暂无本次已验证的关闭方式，不宣称已关闭。

当前交付仅影响 calli 会话，没有自动写入此全局配置。终端直接 `zcode --resume` 不继承 calli 的偏好请求和工具白名单。

## 接入方式

内置实例注册 `zcode`。已有 `data/agents.json` 不会被自动覆盖，可通过已有的发现/添加实例入口添加；配置示例：

```json
{
  "agents": [
    { "id": "zcode", "adapter": "zcode", "command": ["zcode", "app-server"] }
  ]
}
```

这个示例用于说明单个实例，实际文件应保留已有 agents。实例可通过 env 指定 zcode 已有的模型配置环境变量。模型列表通过 `persistence: "deferred"` 的临时会话读取并关闭；不提交 prompt，也不创建持久线程。

支持 API 模型，以及原生 CLI 已登录的 BigModel / Z.ai 个人 Coding Plan。账号接入只读原生凭据：启动 app-server 前定位内置模型目录，通过 `provider/updateAccountConfig` 同步供应商可用状态；模型列表、默认模型与思考档位仍取自原生会话快照。每次 `interaction/requestProviderRuntimeHeaders` 回调重新读取当前账号的凭据，经会话和供应商匹配后回复本次请求的鉴权材料。凭据不进入模型列表、日志或 Hub 持久配置；退出登录或切换账号后，旧会话拒绝继续使用该身份。团队套餐、Start Plan 等其他账号模式暂不支持。历史导入、fork、原生会话删除暂不开放，额度查询边界见下文。所有差异均由 capabilities 表达，前端不按 zcode 名称分支。

原生 CLI 的账号初始化与 app-server 的 Host 账号同步不同，仅传默认模型不能完成注册。账号同步必须绑定同一份内置目录的版本和路径；优先使用实例的 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`，否则查找当前平台、控制面地址对应的唯一原生缓存。有多个版本时，使用 `ZCODE_APP_VERSION` 缩小范围或显式指定目录文件，不猜测应使用哪个版本。两个配置路径只传给本次子进程，不改用户文件。供应商同步回执只表示收到，最终是否可用仍以原生模型列表为准。没有可用模型时保留入口和说明，不补造模型或通用思考档位。

## 图片输入

通过 `session/send.attachments` 发送图片，支持图文、多图和纯图片消息。优先传 Hub 已保存的 `localPath`；没有文件路径时传 `dataBase64`，保留 `kind: image`、文件名和 MIME 类型。图片能力读取原生模型的 `properties.inputFormat.supportsImage`，明确不支持的模型提示换模型；未报告的能力保持未知。斜杠命令带图会明确报错，不静默丢弃附件。前端沿用统一的能力判断与上传入口。

## 协议与实现

```text
calli adapter → 原版 zcode app-server
  → provider/updateAccountConfig（有已登录个人 Coding Plan 时）
  → create/resume + 工具/工作流设置
  ← requestRuntimePreferences → memoryEnabled=false
  ← requestProviderRuntimeHeaders → 本次请求鉴权（校验会话、供应商和账号）
  → subscribe(desktop-continuous)
  → send/compact → turn.started → 流式/工具/审批 → turn.completed/failed
```

zcode 帧不含标准 JSON-RPC 的 jsonrpc 字段，因此使用 `adapters/zcode-wire.ts`；不套用 Codex 协议。adapter 以 sessionId、inputId 和 turnId 过滤输出，以 eventId 去重。停止等待提交被接纳后发送，避免 stop 先到而漏掉轮次；进程关闭和控制请求超时释放 pending 请求与轮次。

## 验证

- 假 agent：创建/恢复参数、记忆偏好、旧协议拒绝、活跃目标拒绝、模型探测、流式、工具、审批选项校验、取消、压缩、提交失败及崩溃。
- Plan 回归：同会话切换 plan/build、提问答案回传、批准或反馈、原生模式事件同步、排队消息保留模式；真实 CLI + 本地模拟模型验证计划模式禁止写文件、AskUserQuestion 请求用户输入、ExitPlanMode 批准后切回执行。
- 账号回归：BigModel / Z.ai 模型同步、选择、恢复、实际请求鉴权，凭据轮换、退出与切换账号，错误供应商/会话拒绝，配置不变、日志无凭据，以及缓存目录歧义。真实本机个人 Coding Plan 已返回 GLM-5.3、GLM-5.3-Flash，两个模型均在隔离测试会话完成实际回复，并验证恢复后切换模型及设置强度。真实账号的 Chromium 桌面/手机、亮色/深色已验证模型列表和选择；只读 UI 复验：`CALLI_ZCODE_REAL_BIN=zcode node --test packages/e2e/test/zcode-account-real.spec.mjs`。
- 未修改的真实 zcode 0.16.9 + 本地模拟 OpenAI API：模型发现、新建、恢复、流式回复、压缩和模型工具列表；在项目配置显式开启记忆、预置 MEMORY.md 标记时，请求中无该标记、文件不变且无额外记忆提取请求。复验命令：`CALLI_ZCODE_REAL_BIN=zcode npx tsx --test packages/daemon/test/zcode-real.test.ts`。
- 图片回归：假 agent 校验本地/内联附件与命令拒绝；真实 CLI + 本地模拟 API 验证图文、纯图和两种附件的图片字节到达上游；`zcode-images.spec.mjs` 验证浏览器上传与发送、纯图消息、文本模型拒绝，覆盖桌面/手机 × 亮/暗。
- Chromium：桌面 1440×1000、手机 390×844，亮色与深色；四张截图实际查看。
- `npm run typecheck && npm test && npm run build`。构建保留仓库已有的大 bundle 提示。

## 与其他 adapter 的能力对齐

- 与 pi 的 `/session` 对齐：读取会话信息；模型和强度仍通过共用选择器修改。
- `/usage` 使用原生 `session/usage` 查询会话累计 token、缓存和请求数，不代表套餐剩余额度；不会发送模型请求。
- 上下文统计读取 `session/read` 的 `runtime.contextUsage`，在每轮回复及压缩结束后更新统一用量事件；恢复会话和切换模型后沿用原生测量与有效窗口。累计 token 不作为当前上下文占用，原生未提供费用时不估算费用。压缩后若暂缺测量，清除旧占用；统计读取失败不会把已成功的回复改成失败。具有压缩能力的实例即使暂无统计，也保留「上下文 → 压缩」入口。
- Codex 的套餐额度来自 `account/rateLimits/read`；zcode 当前 app-server 没有相应接口。zcode 桌面端通过独立供应商服务和鉴权查询套餐额度，本 adapter 通过只读解析 CLI 默认供应商及其匹配账号的缓存凭据查询 BigModel / Z.ai 个人 Coding Plan，并接入左下角额度看板。查询不创建会话、不刷新或写入凭据；团队套餐、Start Plan 和自定义供应商暂显示未支持。可沿用原生 `ZCODE_BIGMODEL_USAGE_API_KEY` / `BIGMODEL_USAGE_API_KEY` 与额度 URL 环境覆盖。额度是默认账号的套餐数据，不是当前会话 token 的换算值。
- 记忆关闭、工具白名单和精简模式保持不变。`/help` 列出实际支持命令，不暴露无法执行的 TUI、Skills 或工作流命令。
