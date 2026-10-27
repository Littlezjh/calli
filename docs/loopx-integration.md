# LoopX 独立插件接入

## 实现范围

外部扩展安装、独立 Node 进程、受控命令与工作投影已实现，LoopX 是第一个独立数据源包。用户选择安装方式；核心不包含 LoopX 字段解析或 agent 名称分支。原生执行沿用已有适配器，首版没有任务控制或自动续轮。

内置看板升级为 0.2.0，新增 `worksource.read` 权限。原安装必须重新确认权限；每个关联还要单独允许看板读取。会话核心读取已绑定来源，看板只能读取授权来源与关联线程的交集。

## 包与安装

扩展目录预置 LoopX 支持项：默认可见、未安装，不启动插件或查询 LoopX。点击「安装」使用宿主附带的独立包，沿用预览与权限确认；安装后同一张卡片显示配置入口，卸载后恢复可安装状态。自定义目录和 HTTPS 包仍可使用。

包根目录包含 `manifest.json`、独立 `.mjs` 入口及依赖的静态文件；依赖应打包或使用 Node 内置模块。宿主支持本机绝对目录、HTTPS `.tgz`（含 npm pack 的 `package/` 布局）。URL 安装必须提供 SHA-256；预览只复制、校验文件，不执行插件。拒绝路径穿越、符号链接、特殊文件、超限包和覆盖内置扩展。

预览有效期十分钟，上限十份；确认绑定预览 token 与完全匹配的权限。安装握手检查 `extension.validateSettings`，失败保留旧版本。只保留一个可直接回退的版本；若回退会改变权限，重新安装旧包并确认。用户本机安装状态、设置及关联保存在 Hub 的数据目录，不进入 agent 的目录。

插件是以 daemon 用户身份运行的可信本机代码，不是沙箱。安装对话框明确说明这一点。仅在用户确认后启动插件；命令环境不转交 Hub token。

## 最小公共契约

- 清单：`process.entry`、`settings`（installation / binding）、`commands`、`contributes.workSource`。外部首版不加载浏览器 JS、DOM 或 CSS。
- stdio：逐行 JSON-RPC 2.0。宿主请求 `extension.detect`、`extension.validateSettings`、`worksource.snapshot`；插件调用 `commands.run`，仅提交清单命令 ID 与可选 binding ID。参数只能由清单、已保存设置和授权关联生成，不能提交 shell 字符串。
- 请求上限 30 秒，命令默认 15 秒、最多 20 秒；单次命令输出和协议行限制 2 MiB。停用取消在途请求及已启动的命令子进程，只处理自己保存的进程句柄。进程出错后最多重新启动两次，重新启用可以重置。
- `WorkBinding`：外部 ID、关联线程、绑定设置、获准消费的视图 ID、可选完整界面 URL。机器由承载它的 daemon 确定。
- `WorkSnapshot`：来源标题、状态、可选多语言状态标签、摘要、带稳定 ID 的工作项、完整性、可选来源更新时间与完成依据。宿主不从轮次结束推断完成。
- `WorkProjection`：宿主附加来源、关联范围、代次、版本、观察时间和新鲜度；投影不给视图返回 registry / executable 配置。重启重新获取快照；晚到响应不能越过停用或关联变更。
- WebHost 提供 `workSources.snapshot/subscribe` 与统一摘要/详情组件。核心会话和看板使用同一个宿主投影，看板不依赖 LoopX 包。

HTTP 入口均沿用 Hub 鉴权：

| 方法与路径 | 用途 |
| --- | --- |
| POST `/api/extensions/prepare` | `{origin, sha256?}`，返回预览 token、清单与内容摘要 |
| POST `/api/extensions/commit` | `{token, granted}`，确认安装或升级 |
| GET / PUT `/api/extensions/:id/configuration` | 读取 / 保存设置与关联 |
| POST `/api/extensions/:id/detect` | 检测现有工具及兼容版本 |
| POST `/api/extensions/:id/rollback` | 回退前一版 |
| GET `/api/work-sources` | 可按 consumer / threadId 过滤；`refresh=1` 请求刷新 |

启停、卸载复用原来的扩展接口。来源开启、绑定、相关轮次结束、重新同步及页面轮询触发读取；同一关联合并在途请求并限制重复查询，同一插件的多个目标串行读取。原始线程事件留在宿主，外部插件首版不订阅会话内容。读取失败显示未知或可能过时，不影响核心发送或审批。

## LoopX 1.4.2 验证

依据 [固定版安装说明](https://github.com/loopx-project/loopx/blob/v1.4.2/docs/guides/installing-loopx.md)、[状态命令](https://github.com/loopx-project/loopx/blob/v1.4.2/loopx/cli_commands/status_registration.py) 和 [Codex 原生接法](https://github.com/loopx-project/loopx/blob/v1.4.2/docs/product/runtimes/codex-cli/codex-cli-packaged-install.md)。兼容基线不跟随主分支预发布版本漂移。

在隔离临时环境安装正式版，创建测试 registry 和目标，执行带 goal 过滤的 JSON 查询；首次测试比较项目与 runtime 目录文件哈希，无变化。新增真实待办后再次查询，验证稳定标识为 `todo_id`。脱敏投影样本进入插件测试；缺失目标、错目标、部分列表和缺失标识都有回归测试。

真实 LoopX 经完整插件进程返回目标与待办。真实 Codex 0.160.1 通过现有适配器发现隔离测试目录中的 LoopX 技能，接受并结束 `/goal` 验证轮。这证明技能发现和原生目标入口可用；尚未完成长时间多轮推进、额度耗尽恢复和真实人工审批的整套验收，不能将此冒充完整长程验证。

自动化覆盖外部安装、校验和、权限、关联撤销、进程退出/取消、升级握手失败保留旧版、回退、卸载清理、重启恢复及多目标读取。浏览器测试覆盖外部包安装与关联、会话/看板/详情和停用卸载，分别检查桌面/手机尺寸及亮暗主题，并人工查看截图。

本次验收：`npm run typecheck && npm test && npm run build` 通过；单元与集成测试共 674 项通过，1 项原有真实 zcode 测试跳过。LoopX 浏览器测试 3 项和原有扩展浏览器回归 8 项通过。安装包可通过 `npm pack -w @calli/ext-loopx` 独立生成；未重启当前运行的 Hub，也未在用户的 agent 环境自动安装 LoopX。
