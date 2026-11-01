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

人面对的始终是大肥鱼一个；背后分两层：

- **Router：一个常驻私人对话。** 在个人目录里，用私人设置的 agent，建议轻量模型。只负责听人说话、归类、分派、汇总回复，不做具体工作；入口提示要求它不跑构建、不改代码，只用 `calli todo` / `calli notify` 一类命令。人在大肥鱼输入框里说的话都进这一个对话；它在忙时，新消息排队，下一轮一并处理（批处理）。
- **Worker：工作线程。** 由 Router 用 `calli todo delegate ID` 开出，一件事一个，上下文互不干扰；结果写回事项的接续说明和卡片，再由 Router 统一告诉人。
- **回复短。** Router 对人的每次回复不超过 100 字；早晚报同样有上限。

后续（未排期）：

- **两级过滤。** `profile.md` 里的信息源先用代码规则筛（来源、群、谁发的、是否 @我），过了规则的才交给 Router 判断。
- **订阅直通。** 事项带 `subscriptions`（飞书话题、PR、邮件串）。这些地方的新消息直接成为该事项的卡片并通知在跟的 Worker，不再经过 Router。
- **链式召回。** 卡片带关联对象的 ID（事项、对话、人、决定），`calli` 读取时只给摘要和 ID，需要时再逐跳展开。
- **提前行动。** 新发现附上已备好的材料（日程冲突、回复草稿、提纲），人点「跟踪」时材料已在那一叠里。
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
