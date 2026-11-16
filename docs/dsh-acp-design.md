# DeepSeek Harness（dsh）ACP 接入

## 范围

不改 dsh 的源码与配置，不在主机上留额外状态：calli 启动原版 `dsh --profile acp`（stdio 上的标准 ACP v1），一个线程一个进程。dsh 自己的登录、模型与 API key 在它自己的设置里配（`dsh web` 的 Settings → Models），calli 不读写 `$DSH_HOME`。

## 接入方式

内置实例注册 `dsh`，默认命令 `dsh --profile acp`；`CALLI_DSH_BIN` 换可执行文件。已有 `data/agents.json` 不会被覆盖，可用现有的发现/添加入口补一个实例：

```json
{ "id": "dsh", "adapter": "dsh", "command": ["dsh", "--profile", "acp"] }
```

适配器复用 `adapters/acp.ts` 的公共协议层（`adapters/dsh.ts` 只有 dsh 特有部分）。协议依据：dsh 0.2.1 的 `@deepseek-ai/dsh-acp`（ACP automation-only 服务）。

## 协议事实（按真实 CLI 0.2.1-rc.5 验证）

| 能力 | dsh 的做法 | calli 的映射 |
|---|---|---|
| 恢复会话 | `session/resume`，恢复不回放历史；`session/load` 不存在（Method not found） | 适配器 `resumeVia`；线程历史靠 hub 自己的事件日志 |
| 会话模式 | 无 modes，`session/set_mode` 会拒绝 | 无权限档、无计划模式；权限仍走逐次审批 |
| 审批 | `session/request_permission`，选项只有 `allow-once`/`reject-once`，`toolCall` 只带 `toolCallId` | 适配器用之前 `tool_call` 更新里的标题/参数回填审批卡 |
| 模型 | `model` 选项按 provider 分组（`options[].options[]`），值是不透明路由 id `["provider","model"]` | 分组拍平成模型列表，provider 名并入描述；路由 id 原样存取 |
| 思考强度 | `reasoning_effort`（category `thought_level`），只有推理模型声明；可能有空值「Provider default」 | 空值不是档位；无该选项的模型不显示强度选择 |
| 图片 | `initialize` 报 `promptCapabilities.image`，按当前路由在提交时校验 | 线程可发图；模型不支持时该轮报错 |
| 用量 | `usage_update` 只有 used/size，无费用 | 只显示上下文占用，不估算费用 |
| 会话管理 | `session/list`、`session/close`；无 delete、无 fork | 不提供导入/分叉/删除原生会话 |
| 结束原因 | `end_turn`/`max_tokens`/`cancelled` | 与其他 ACP agent 相同处理 |

## 能力边界

- **无权限档与计划模式。** 界面不显示权限选择器和计划开关；dsh 的守卫策略由它自己的配置决定，需要批准的操作逐次询问（允许一次/拒绝）。
- **协作可用。** 会话环境带上 calli CLI 的运行时凭证（`CALLI_TEAM_*` 等，仅进程内、不落盘），dsh 通过自己的工具调 `calli` 命令参与协作与团队。
- **无 `/compact` 入口、无额度接口、无原生目标。** capabilities 均未声明，前端按能力隐藏。
- **审批选项只有一次性允许/拒绝**，没有「始终允许」；这是 dsh 的自动化面有意为之。
- **终端恢复命令是 `dsh web`**：内置 profile 没有按会话恢复的终端命令，Web UI 里可以继续这个会话（会话的工作目录就是线程目录）。
- **模型探测会留下空会话。** 读取模型列表要开一个不发消息的会话，dsh 会把它落盘，而 ACP 面没有删除接口；结果有缓存，每次刷新列表多一个空会话，属于已知噪音。
- **一个会话一次一个 prompt。** 与 hub 每线程串行一致，无额外约束。
- 余额耗尽（DeepSeek API 的 `Insufficient Balance`）识别为额度用完，用于交接建议；其他供应商错误按原文显示。

## 已验证 / 未验证

- 假 agent（`fake-acp.mjs`，`FAKE_ACP_FLAVOR=dsh`）：分组模型拍平与默认标记、逐模型强度探测、不可选模型保留、`session/resume` 恢复与不可恢复报错、无计划模式、审批回填与 allow-once/reject-once、图片透传、无费用用量、取消。
- 真实 CLI 0.2.1-rc.5：`initialize`、`session/new`（分组模型与 reasoning_effort）、伪造模型值被拒、`session/load` 不存在、`session/list`、`session/close`、`session/resume`；适配器 `models()` 对真实进程返回 `deepseek-v4-flash` 及 off/low/high/max。
- 真实 API key + 本地 proxy：官方 DeepSeek（deepseek-flash）、cliproxy（traex-bridge 的 OpenAI 兼容面，GPT-5.6-Luna）、magpie 网关（workbuddy/deepseek-v4.1-flash）各完成一条真实回复；适配器读到 4 个 provider 共 63 个模型。magpie 网关会自行接管 dsh 里的 magpie provider 配置（含 `MAGPIE_GATEWAY_KEY` 引用与 `magpie-anthropic` 路由），凭据需在 `~/.dsh/.credentials.yaml` 补上该引用。
- 在真实浏览器里的展示已用假 agent 看过（桌面/手机 × 亮/暗）；真实账号的浏览器流程待合并到主工作区后复验。

## 后续（未排期）

- dsh ACP 面开放会话删除或历史回放时，补导入/分叉与原生会话删除。
- `session/list` 条目带标题与时间后，可考虑接入导入列表。
