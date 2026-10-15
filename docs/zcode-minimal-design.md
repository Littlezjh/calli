# zcode 精简接入（配置与协议方案）

## 范围

不修改 zcode 源码、不安装定制 CLI、不改用户全局配置。limi 启动原版 `zcode app-server`，通过已有协议关闭记忆、限制工具与工作流。

精简不是无状态：保留原生会话历史、恢复、模型选择、思考档位、取消、压缩。自动跨会话记忆与会话历史分开。旧历史已经包含的记忆文字不会被删除。

## adapter 已实施的设置

| 功能 | 现有入口 | 行为与边界 |
|---|---|---|
| 自动记忆 | `session/requestRuntimePreferences` | 创建/恢复及执行前回复 `memoryEnabled: false`；旧服务不请求偏好则拒绝继续。主记忆读取和提取均受此总开关约束 |
| 工具范围 | create/resume 的 `toolAllowlist` | 仅允许 Read、Write、Edit、Bash、Grep、Glob；以实际 CLI 注册工具为准，本机 0.16.9 的模型请求中实际是前四种 |
| 工作流/闲时任务 | create/resume 的 `dynamicWorkflowEnabled`、`offPeakToolEnabled` | 均为 false；不注册相应调用工具 |
| 额外搜索增强 | 运行时偏好的 `nativeSearchEnhancementsEnabled` | false；基础 Shell 搜索仍可用 |
| 自动回答提问 | `askUserQuestionAutoResolutionEnabled` | false；额外提问工具不在白名单内 |
| 自动标题 | create 的 `titleGenerationEnabled` | 新会话为 false；resume 协议没有同等字段，不承诺所有历史会话完全无标题请求 |
| 会话 MCP | create/resume 的 `mcpServers: []` | 空数组会被本机 CLI 当作未覆盖；用户配置和插件 MCP 仍可能初始化，只有模型调用面受工具白名单限制 |
| 命令 | adapter 的命令入口 | `/compact`、`/help`、`/session`、`/usage`；查询命令本地处理，不提交模型；不展开自定义命令或工作流 |
| 原生长期目标 | 恢复 snapshot 的 target | 活跃目标拒绝接入，请用户在 zcode 停止目标或另建线程；adapter 不改写目标状态 |

模型实际看到的工具范围受白名单限制，但 Shell 仍是通用执行能力，白名单不是操作系统沙箱。

**权限差异：** 本机版本把 `toolAllowlist` 同时投影到 permission.allowedTools，基础工具会被免审批。adapter 不提供三档权限选择，使用 build 模式，继续处理 zcode 真正发出的审批请求（例如用户已有的更高优先级规则）。不能把这一接入显示为“每次操作请求批准”。

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

当前交付仅影响 limi 会话，没有自动写入此全局配置。终端直接 `zcode --resume` 不继承 limi 的偏好请求和工具白名单。

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

当前支持 API 模型配置。zcode 桌面账号依赖 Host 动态鉴权回调，尚未接入；收到相应请求会明确报错，不读取或复制桌面凭据。图片、历史导入、fork、原生会话删除和额度查询暂不开放。所有差异均由 capabilities 表达，前端不按 zcode 名称分支。

账号套餐的默认模型不等于 app-server 已注册的可用模型：原生 CLI 的账号初始化与 app-server 的 Host 账号同步不同。仅配置账号套餐时，模型列表可能为空。Hub 不补造模型或通用思考档位；思考档位只采用模型列表声明的值。创建或恢复会话后若没有可用模型，在设置强度或发送消息前说明 API 模型接入要求并关闭连接。额度查询可用也不代表模型调用鉴权已接入。

## 协议与实现

```text
limi adapter → 原版 zcode app-server
  → create/resume + 工具/工作流设置
  ← requestRuntimePreferences → memoryEnabled=false
  → subscribe(desktop-continuous)
  → send/compact → turn.started → 流式/工具/审批 → turn.completed/failed
```

zcode 帧不含标准 JSON-RPC 的 jsonrpc 字段，因此使用 `adapters/zcode-wire.ts`；不套用 Codex 协议。adapter 以 sessionId、inputId 和 turnId 过滤输出，以 eventId 去重。停止等待提交被接纳后发送，避免 stop 先到而漏掉轮次；进程关闭和控制请求超时释放 pending 请求与轮次。

## 验证

- 假 agent：创建/恢复参数、记忆偏好、旧协议拒绝、活跃目标拒绝、模型探测、流式、工具、审批选项校验、取消、压缩、提交失败及崩溃。
- 未修改的真实 zcode 0.16.9 + 本地模拟 OpenAI API：模型发现、新建、恢复、流式回复、压缩和模型工具列表；在项目配置显式开启记忆、预置 MEMORY.md 标记时，请求中无该标记、文件不变且无额外记忆提取请求。复验命令：`RAH_ZCODE_REAL_BIN=zcode npx tsx --test packages/daemon/test/zcode-real.test.ts`。
- Chromium：桌面 1440×1000、手机 390×844，亮色与深色；四张截图实际查看。
- `npm run typecheck && npm test && npm run build`。构建保留仓库已有的大 bundle 提示。

## 与其他 adapter 的能力对齐

- 与 pi 的 `/session` 对齐：读取会话信息；模型和强度仍通过共用选择器修改。
- `/usage` 使用原生 `session/usage` 查询会话累计 token、缓存和请求数，不代表套餐剩余额度；不会发送模型请求。
- Codex 的套餐额度来自 `account/rateLimits/read`；zcode 当前 app-server 没有相应接口。zcode 桌面端通过独立供应商服务和鉴权查询套餐额度，本 adapter 通过只读解析 CLI 默认供应商及其匹配账号的缓存凭据查询 BigModel / Z.ai 个人 Coding Plan，并接入左下角额度看板。查询不创建会话、不刷新或写入凭据；团队套餐、Start Plan 和自定义供应商暂显示未支持。可沿用原生 `ZCODE_BIGMODEL_USAGE_API_KEY` / `BIGMODEL_USAGE_API_KEY` 与额度 URL 环境覆盖。额度是默认账号的套餐数据，不是当前会话 token 的换算值。
- 记忆关闭、工具白名单和精简模式保持不变。`/help` 列出实际支持命令，不暴露无法执行的 TUI、Skills 或工作流命令。
