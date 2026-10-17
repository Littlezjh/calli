# 概览：每日执行分析

侧边栏「概览」一页回答三个问题：每天得到的 prompt 是什么、模型整体的 prompt 是什么、调了哪些 MCP。不做费用分摊（那是「用量与诊断」的事，见 observability-design.md）。点某条提问，打开那一轮的执行轨迹（trace），看这一轮从提问到回答中间发生了什么。

## 开源项目怎么做

| 项目 | 做法 | 借鉴 |
|---|---|---|
| ccusage | 只读各家 agent CLI 的本地会话/用量文件，出每日/每周/每月 token 与费用报表；支持 18 种 CLI，不看 prompt 内容 | 「按天聚合、读本地文件、不发数据」；我们不另做报表，token 归 observability |
| Langfuse | 自托管 LLM 观测平台：trace 里存完整 prompt/回复/工具调用，看板按天聚合、按模型筛选 | 「prompt 全文可看、按天翻」；我们不引平台，直接用 hub 自己的事件日志 |
| OpenLIT | OTel 采集 GenAI/agent 框架的 trace 与用量，看板 + trace 查看器 | 同上 |
| Claude Code 官方 OTel | metrics（token/费用/commit）+ 事件日志：`user_prompt`（可含全文）、`tool_result` 带 `mcp_server.name`/`mcp_tool.name`，`prompt.id` 串起一轮 | 「用户 prompt 全文 + MCP 按服务归因」正是这页的口径；我们不需要用户搭 collector |
| opcode、pi-web | 读 `~/.claude/projects` 等落盘文件浏览会话与用量 | hub 的 `turn_text` 本来就有全文，不必再解析 agent 文件 |

## 数据从哪来（已在真实落盘文件上验证）

| 问题 | 来源 | 说明 |
|---|---|---|
| 每天的用户 prompt | hub 自己的 `turn_text` 表 | 每轮用户原话带时间戳，导入、终端同步的轮次也在；hub 发起的交接/协作消息已排除 |
| 整体（系统）prompt | agent 落盘的会话文件，只读 | Claude：JSONL 里的 `attachment.prompt_snapshot.systemPrompt`（取最新快照）；Codex：rollout 首条 `session_meta.payload.base_instructions`；pi：会话文件 `role:"system"` 消息的 `sections` 按写入顺序拼接。协议流里没有，只能读文件 |
| 调了哪些 MCP | 统一事件的 `tool.start` | 补存了原始工具名：Claude/pi 是 `mcp__服务__工具`，Codex 的 `mcpToolCall` 另给 `server`；两者都归一到「服务 · 工具」。旧记录没存名字，按当时记录的 kind 归类，不倒推补造 |

agy 和 zcode 的会话文件未验证出系统提示词的可靠位置，`capabilities.systemPrompt` 不开，页面上不显示按钮；后续验证了再加，差异只在适配器里。

## 接口

- `GET /api/activity?days=N`（N 钳到 1..90，可带 `agent=`）：返回 `{ days: [...] }`，按 daemon 本地日分组、旧日期在前。每天：`turns`/`threads` 计数、`prompts`（至多 50 条，超出计 `morePrompts`；每条带线程、agent、标题、原文，长文截 400 字）、`tools`（按原始名或旧类别，至多 12 个，MCP 带标记与 `server`）、`mcp`（按服务汇总）。归档线程计入；永久删除的线程随事件级联消失。
- `GET /api/threads/:id/trace?turn=ID`：一轮的执行轨迹，不带 `turn` 时取最后一轮；没有这一轮 → 404。返回线程标题、agent、目录、用到的模型、状态（运行中/完成/已停止/出错）、起止时间、合计（工具次数、MCP 次数、模型请求数、输入/输出 token），以及线程所有轮次（用来翻上一轮/下一轮）。`steps` 按发生顺序排列：`user`（提问原文）、`thinking`、`assistant`（流式片段拼成一段）、`tool`（开始、更新、结束合成一步，带原始名、标题、输入、输出、状态，MCP 带 `server`）、`request`（每条 `usage.sample` 一步，带模型和 token）、`context`（压缩）、`error`。单段文字超过 2 万字截断并标 `cut`，完整内容仍在会话里。数据全部来自 `events` 表，按 `turn.started` 的 seq 区间读这一轮，不扫整个线程。
- `GET /api/threads/:id/system-prompt`：`{ text, source }`。适配器无能力 → 400；线程还没有会话 → 400；会话文件里没有 → 404。读文件是流式扫描，至多 8 MiB；缺文件不算错误。

## 存储

不新增表：提问来自 `turn_text`，工具来自 `events`。`events` 增加 `tool.start` 的部分索引（`ON events(ts) WHERE type = 'tool.start'`），大库上按天取工具行不用全表扫；首次在新版本 daemon 打开旧库时建一次。

## 界面

文档式一页（同计划页），地址 `#/activity`，侧边栏「概览」一行。范围 7/14/30 天记在本机。每天一节：日期头（今天/昨天/「10 月 14 日 · 周三」）加「N 轮 · M 个会话」；工具一行 chips，MCP 的带 `mcp` 小标和服务名；下面按会话分组列当天的提问（时间 + 原文一行，点回会话）；有能力的会话带「系统提示词」，Dialog 里全文滚动、可复制、注明来源。手机上会话行换行、字号收紧。每条提问右侧标「N 个工具」，点提问打开「执行轨迹」面板（桌面居中，手机是底部抽屉）：顶部是会话名（点击回到会话）、状态、上一轮/下一轮，下面是 Agent、模型、开始、用时、工具、模型请求、目录；再下面是按类型筛选（全部/系统/用户/思考/回答/工具/请求，带数量）和搜索，滚动时固定在顶部；最后是步骤列表，每步一行（类型、工具名、摘要、相对开始时间和耗时），点开看全文或工具的输入输出。有系统提示词能力的 agent，列表第一行是「系统」，点开时才读取。运行中的轮每 3 秒刷新。

## 已知边界

- 系统提示词按会话读，同一天多个会话各是各的；快照取会话里最新一条（Claude 中途换了技能/MCP 时以最新为准）。
- 洪峰日（如定时任务轰炸）每至多列 50 条，其余计数；原文截 400 字，完整轮次仍在会话里。
- 旧事件没有工具名，统计里出现的是类别（「读取文件 ×N」），MCP 明细从新记录起算。
- 快捷键、按 agent 筛选的界面入口暂无（接口已支持 `agent=`）。
