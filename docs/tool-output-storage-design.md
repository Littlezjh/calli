# 工具输出的存储：塌缩、封顶、按需回读

## 问题

`hub.db` 的 `events` 表存了每个事件的完整载荷。工具调用在执行中每次输出增量，适配器发来的
`tool.update` 都带**累计全文**（如 Codex 的 `item/commandExecution/outputDelta`，见
`adapters/codex.ts`），hub 原样入库。一条命令输出 2.4MB、流式更新 573 次，就存 693MB。
真实数据：277 线程、298 万条事件、`events` 表 10.2GB，其中 `tool.update` 16 万条 9GB，
去重后有效信息只有 47MB（191 倍冗余）。对话正文本身（message/reasoning delta 共 267 万条）
只有 41MB，不是问题。

Agent 各自的会话文件仍是源头（hub 只读）。hub 侧事件日志的存在理由：统一六种会话格式、
流式回放（带序号时序）、承载只存在于 hub 侧的数据（审批、用量、编辑史、导入标记）、
跨格式搜索，以及 agent 会话被删/压缩/分叉后线程仍完整可见。要改的不是"存不存"，
而是工具输出这类**大而可替代**的载荷怎么存。

## 方案

读侧本来就把工具事件的连续快照合并成一条（`events.ts` 的 `coalesceToolEvents`，
注释明确"store 保留全部中间态，这只是分页的呈现方式"）。现在把同样的塌缩移到写入侧：

1. **塌缩（keep-last）。** `Store.appendEvent` 写入 `tool.update` 时，若同线程同工具 id
   已有更早的 `tool.update` 行且新事件完整替代它（新事件带 output 就替代旧 output，
   带 diff content 就替代旧 content；旧事件带有而新事件没有的字段时保留旧行，避免丢
   diff —— 此时同工具至多两行，仍有界），删除旧行及其 `history_rows` 投影行。
   `tool.end` 带最终输出，适用同一规则。每个工具调用因此最多留一条中间快照和一条结束。
   活跃轮的 SSE 推送不变（推送的是新事件本身），刷新后从日志回放拿到的也是最后一条快照，
   与现状一致；`seq` 只增不减，删除留下空洞不影响游标续读。
2. **封顶。** 单条 `output` 超过 128K 字符时只存前 96K 与后 32K，中间一行
   `[truncated, N chars omitted]`，并记 `outputTruncated: true`、`outputOmitted: N`。
   diff content 不封顶：`history.record` 要对它算 diffStats，截断会算错增删行数。
3. **按需回读。** 详情接口（`history.detail`）的返回带上截断标记与"能否回读"
   （`capabilities.history`）。新增
   `GET /api/threads/:id/history/tool-output?turn=&id=`：适配器 `loadHistory`
   （只读会话文件）按工具 id 找到该次调用的完整输出返回。找不到、实例不支持、
   会话已不在，都分别明确报错，不拿截断文本冒充完整。
4. **前端。** 工具步骤展开后若输出被截断，显示"加载完整输出"；加载中、失败、
   agent 侧也没有，各有各的说法。文案进 `i18n/locales`。
5. **存量迁移。** 启动时（`hub_settings` 标记防重）分线程批量执行同一塌缩规则，
   删除被替代的 `tool.update` 行与投影行，同步 `history_details` 的引用
   （`record` 已把 `output_seq` 指到最新事件，只需删行）。文件空间由
   `scripts/compact-hub-db.sh` 在停机窗口执行 `VACUUM` 回收；迁移后新写入复用
   空闲页，库停止增长。

## 不做的事

- 不改适配器发什么（协议语义不变），不改前端回放与合并逻辑（`coalesceToolEvents`
  对塌缩后的日志依然成立）。
- 不存增量再在读取时拼接——keep-last 与"存增量读时合并"信息等价，但少一层
  读取端状态，且对非前缀型更新（zcode 的 tail、diff 替换）天然正确。
- 不碰 `edited_events`（66 行，可忽略）与 `copyEvents`（复制已塌缩的行）。

## 测试

- 塌缩：同 id 多次 update 只剩最后一行 + end 行；`output_seq` 指向幸存行；
  `detail()` 读回最终输出。
- 封顶：超长输出截断且带标记，diff 不截断。
- 回读：假 agent（有 history 能力）返回会话里的完整输出；找不到工具 id 报 404；
  实例不支持报明确错误。
- 迁移：种入旧行，跑迁移，行数与引用符合预期，标记防重跑。
