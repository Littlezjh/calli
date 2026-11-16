# 私人数据落盘：个人目录里的文件

2026-10-31 · 设计稿。界面草图见 `docs/design/personal-wall.html`。接在 [个人 agent](personal-agent-design.md) 后面。

## 结论

个人目录里的文件是准，Calli 和各家 agent 都读它；agent 只经 `calli` 命令写；SQLite 只做索引，删了能重建。个人目录用本地 git 记录历史，不推远端。

参考：

| 项目 | 做法 | 取什么 |
|---|---|---|
| Backlog.md | 一个任务一个 `.md`，经 CLI / MCP 改，不建议手改 | 一件事一个文件；agent 走命令 |
| Basic Memory | Markdown 为准，旁边 SQLite 索引可重建；人能在 Obsidian 里直接改 | 文件为准、索引可重建、`[[链接]]` |
| beads | 早期 git 里的 JSONL 多写冲突多，后来换 Dolt，JSONL 只做导出 | 一件事一个文件、只追加、带 rev，避开同文件并发写 |
| Agent Skills | 一个文件夹一份 `SKILL.md`（`name`、`description`） | 沉淀出的 Skill 用这个格式 |

## 目录

```
<个人目录>/                 默认 ~/.calli/personal
├── AGENTS.md              给 agent 的入口，Calli 生成，人可以改
├── profile.md             人写：在意什么、老板与 PM、周报节奏、信息源
├── matters/               事项，一件一个目录
│   └── <id>-<slug>/
│       ├── matter.md      frontmatter + 接续说明
│       ├── cards.jsonl    材料卡片，只追加
│       └── assets/        截图、生成的图与网页
├── inbox.jsonl            新发现（候选），人接受后才成事项
├── journal/YYYY-MM-DD.md  早报、晚报、当天做了什么
├── decisions.md           定下来的事，只追加
├── lessons.md             踩过的坑，只追加
├── people/<name>.md       每个人在意什么、欠他什么
├── skills/<name>/SKILL.md Agent Skills 格式
├── artifacts/             周报、一页纸、推进图
└── .calli/                索引、信息源游标；写进 .gitignore
```

## matter.md

```markdown
---
id: m-7f3a
title: 阈值实验结论发给老板
lane: you            # you | doing | wait | later | done
owner: me            # me | agent
who: 老板
due: 2026-10-31T18:00:00.000Z
follow_up: null
waiting_on: null
rev: 7
created: 2026-10-28T09:00:00.000Z
updated: 2026-10-31T10:12:00.000Z
threads: [<thread id>]
---
## 欠谁什么
## 定了什么
## 做到哪
## 下一步
```

正文就是现有的接续说明，原样写入。

## cards.jsonl

每行一张卡片：`{ "id", "at", "kind", "source": { "type", "ref", "url"? }, "title"?, "data" }`。`kind` 取 `chat | chart | code | doc | shot | check | quote | lesson | page`。图表只存数据，界面统一画。

## 写入规则

1. agent 只经 `calli` 写；命令校验字段、比对 rev、写临时文件再改名，拒绝明显凭据（沿用 `personalText`）。
2. 邮件、飞书、网页读到的内容只进 `inbox.jsonl`，人接受才成事项，也不能把事项标完成。
3. 卡片、日记、决定只追加；`matter.md` 整份覆盖，靠 rev 防覆盖。每次写完 `git commit`（作者 Calli，信息写操作名和事项 ID）。
4. 人手改文件：Calli 监视目录，改动后重建索引（第二步做）。

## 分步

1. **镜像。** 数据库仍为准；事项每次增改删后，把它写成 `matters/<id>-<slug>/matter.md`，完成的事项 lane 为 `done`，删除的事项移走目录。个人目录首次使用时 `git init`、写 `.gitignore` 与 `AGENTS.md`、`profile.md` 模板（已存在不覆盖）。启动时全量对一次。
2. **卡片、收件箱、沉淀。** `calli card add`、`calli inbox add`、`calli keep decision|lesson`、`calli skill propose`，接口与测试。
3. **反转。** 文件为准，SQLite 降为索引，监视人手改。
4. **桌面界面与大肥鱼。** 按草图实现。

## 大肥鱼是 Router（参考 DeepSeek Harness 的 Super-agent 文章）

> 2026-11-01 起，界面上的名称从「大肥鱼」改为「助手」；本文以下仍用「大肥鱼」指代这同一个角色。

人面对的始终是大肥鱼一个；背后分两层：

- **Router：一个常驻私人对话。** 在个人目录里，用私人设置的 agent，建议轻量模型。只负责听人说话、归类、分派、汇总回复，不做具体工作；入口提示要求它不跑构建、不改代码，只用 `calli todo` / `calli notify` 一类命令。人在大肥鱼输入框里说的话都进这一个对话；它在忙时，新消息排队，下一轮一并处理（批处理）。
- **Worker：工作线程。** 由 Router 用 `calli todo delegate ID` 开出，一件事一个，上下文互不干扰；结果写回事项的接续说明和卡片，再由 Router 统一告诉人。
- **回复短。** Router 对人的每次回复不超过 100 字；早晚报同样有上限。
- **协议与显示分开。** 入口说明、个人摘要和飞书 source JSON 只给 agent；对话显示人的原话，飞书批次显示「飞书 · N 条新信号」。新批次的 `turn.started.data.channel` 与 `queued[].channel` 均为 `{ kind: 'lark', count: N }`，前端据此显示系统行；人输入相同文字不带此标记。排队、重试和交接保留来源标记；排队、撤回、重试和交接沿用显示文本，重试及交接仍携带内部提示词。启动时为当前 Router 的旧记录一次性回填显示文本，同步历史投影、搜索与预览，保留原提示词。

后续（未排期）：

- **两级过滤。** `profile.md` 里的信息源先用代码规则筛（来源、群、谁发的、是否 @我），过了规则的才交给 Router 判断。
- **订阅直通。** 事项带 `subscriptions`（飞书话题、PR、邮件串）。这些地方的新消息直接成为该事项的卡片并通知在跟的 Worker，不再经过 Router。
- **链式召回。** 卡片带关联对象的 ID（事项、对话、人、决定），`calli` 读取时只给摘要和 ID，需要时再逐跳展开。
- **提前行动。** 设计已定为分级主动（L0 发现 / L1 准备 / L2 沙盒动手 / L3 对外动作），L1、L2 默认关、用户主动开启，见 [主动行动分级](proactive-design.md)。
- **Watchdog。** 盘点扩展为同时检查工作线程有没有实质进展、是否跑偏。

## 大肥鱼形象

形象用 [dsh-dafeiyu](https://github.com/QCYTSN/dsh-dafeiyu) 的 `assets/pet`（MIT，Copyright (c) 2026 PC2005-cloud）。共 16 段动作、3444 帧、约 55 MB，不放进仓库：第一次打开时下载到 `~/.calli/pets/dafeiyu/`，固定 commit，带上 `LICENSE.txt` 与来源说明。状态对应：空闲 `idle`，处理输入 `thinking`，做完 `success`，点击 `poke` / `head_pat`，偶尔 `idle_yawn`。

## 轻重：重要 × 紧急（2026-11-01）

桌面默认按「轻重」摆，进度（需要你/在跟/等别人/搁着）降为每叠上的状态。

| | 紧急 | 不紧急 |
|---|---|---|
| **重要** | 现在做（「今天先做」从这里取） | 排时间：以后更重要，大肥鱼帮你在空闲时推进或提醒排进日历 |
| **不重要** | 快速处理：一句话回复，或交给 agent | 搁着 |

- **重要** 是人定的或人确认过的：`importance: high | normal | low`。大肥鱼可以建议（理由写清：「老板提的」「OKR 相关」「profile.md 里你说在意」），人点一下才生效。
- **紧急** 由代码算，人可以钉住：截止在 48 小时内或已逾期；有人在等你回复超过一天；今天的会需要它；或人设了 `urgentUntil`。界面上每叠显示一句「为什么急」。
- 每叠带 `source`（来自飞书哪条消息/任务/日程、谁、什么时候、链接），出处在摊开层第一张卡。

## 飞书信号（channel）

先从「和你有关」的四类读起，全部只读：

| 信号 | 命令 | 快速过滤（代码） |
|---|---|---|
| 分给你的任务 | `lark-cli task +get-my-tasks --complete=false` | 全部进入，按截止定紧急 |
| 老板/PM/指定人发的消息 | `lark-cli im +messages-search`（按发送人、时间游标） | 只看 profile 里列的人和群；含请求语气或 @你 |
| 你收藏的消息 | `lark-cli im +flag-list` | 全部进入（你标记过就是想记住） |
| 今天和明天的日程 | `lark-cli calendar +agenda` | 需要准备的会；冲突 |

- **谁来读**：daemon 定时（工作时段每 30 分钟，打开桌面时也可「刷新」）用 `execFile` 调 lark-cli，游标存在个人目录 `.calli/`。未安装或未登录 lark-cli 时，桌面显示一条可操作的提示，不报错。
- **谁来判断**：过滤后的新信号批量发给大肥鱼（Router 的一条触发消息），由它决定：新建建议（带 importance 建议、紧急理由、截止、出处），挂到已有事项（作为卡片），或忽略。外部内容只能成为建议，人确认才上桌。
- **配置**：私人设置里「飞书」一节：开关、关注的人（老板、PM…）、关注的群、读取频率。写在 hub 设置，不写进仓库。
- **不做**：自动回复飞书、代替人发消息；读全部群聊。

### Channel 实现约定

- API 配置可额外传 `workHours: { start: 9, end: 21, timeZone: "Asia/Shanghai" }`；首次默认使用 hub 时区，9–21 点。未传时保留原值。启动不补跑，手动刷新不受时段/开关限制；定时刷新遵守开关和时段。
- 消息首次只看过去 24 小时，之后按关注范围各自保存时间游标；新增关注范围从过去 24 小时开始。人和群分别查询后合并，没有关注范围就不查消息。任务和收藏从第一页开始逐页读取，日程看所配置时区的今天和明天。
- 关注人的角色使用 `boss` / `pm` / `other`。发送人 ID 匹配配置时，信号及 Router 批量消息携带独立的 `senderRole`；不按显示名或外部正文自称推断。来自老板/PM 的请求默认建议重要，理由写「老板提的」或「PM 提的」，仍需人确认。
- 每轮最多送 30 条新信号到 Router，其余摘要和续页位置保存在个人目录 `.calli/lark-cursors.json`，下一轮先清积压。文件权限为 0600，原子替换；读失败或 Router 不接受时不推进游标。同一消息出现在关注列表与收藏时只送一次。
- CLI 固定为只读用户身份调用；状态探测不返回凭据或原始 stderr。可复用 hub 的 `CALLI_LARK_CLI` 指定可执行文件，验收使用独立的 `fake-lark-channel.mjs`，不触碰真实飞书数据。
- 已知事项：Router 投递与游标文件落盘不是跨进程原子事务。进程恰好在两者之间退出时，信号可能重送；Router 必须先按 `source.ref` 查已有事项，避免重复创建。

## 早报与晚报

内容由 `buildBrief(kind, todos, now)` 的确定性模板生成，不调用模型或读取说明正文。仅统计顶层事项；子项的操作和关联对话的活动计入父事项最后活动。重要性的未标记回退与桌面一致（属于人的、且有截止）。标题和正文合计最多 100 个 Unicode 码点；长标题缩短，保留急的原因、等待及发现计数。

- 早报：标题「早报 · N 件现在做」统计全部重要且紧急事项，与桌面页头复用同一轻重判定；正文只列前三件，只给第一件加「先做」，每件保留紧急理由。等待超过三天与当天新发现合为一行计数；超过三件时正文末尾加「…另 N 件」，没有推荐事项时标题只写「早报」。
- 晚报：当天完成数、今天未动的重要事项最多两件、明天优先的一件重要且紧急事项。
- 无相关内容返回 `null`，不发送空推送；页面可用自己的本地化轻松文案显示空状态。
- 设置 `{ enabled, morning, evening }` 默认关闭、`09:00` / `19:00`，时间是 hub 本地 `HH:mm`。需同时开启现有推送总开关，复用飞书机器人队列、重试与记录。
- 调度复用现有 Scheduler，遵守私人盘点的安静时段（默认 23:00–08:00），每天每类最多一次。只匹配设置的分钟，停机或安静时段错过后不补发；发送前持久化每日标记，重启不重复。
- `GET /api/personal/brief/last?kind=morning|evening` 返回 `{ text, sentAt }` 或 `null`。仅在机器人成功发送后按早晚分别持久化：`text` 是当时的标题、换行和正文（不含渠道标识及打开链接），`sentAt` 是发送成功的 ISO 时间。预览、排队、失败和限流不覆盖它；之后事项变化或 hub 重启不改变这份已发送快照。
