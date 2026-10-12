# AGENTS.md

在远程主机上跑 coding agent，用手机或电脑浏览器操作。
要做的事看 `docs/TODO.md`，架构看 `docs/PLAN.md`，设计图在 `docs/design/`。

## 两条原则

1. **简单，不干扰 agent。** 不改 agent 的目录、配置和会话。不做文件树、编辑器。终端例外，是给人的运维工具（见 `TODO.md` 第 10 节），不碰 agent 的会话。
2. **界面要好看。** 标准是 Codex，目标是超过它。丑就是 bug。

## 界面

- 不用浏览器原生控件：弹窗用 `Dialog`，选择器用 `Popover`，图标用 `icons.tsx`，不用 emoji。
- 颜色、圆角、阴影只用 `styles.css` 顶部的变量。
- 文字用中文，按钮写动作（"删除"，不写"确定"）。
- 改完要在真实浏览器里看过：桌面和手机，亮色和深色。没看过就说没看过。

## 代码

- 这个仓库要开源：不写入 token、IP、主机名、个人路径。
- agent 之间的差异只放在 `packages/daemon/src/adapters/`。前端靠 `capabilities` 判断，不按 agent 名字分支。
- 新接口要有测试；适配器的新行为要在 `test/fixtures/` 的假 agent 里有对应实现。
- 文档中文，代码和注释英文。

## 进程

- 重启 hub 只用 `scripts/restart.sh`。不要 `kill`、`pkill -f` 或 `grep dist/index.js` 找进程：你自己就跑在 hub 里，会把正在用的 hub 和你自己一起杀掉。
- 测试时起的 daemon，记下 PID，只按这个 PID 或端口清理。

## 提交前

```bash
npm run typecheck && npm test && npm run build
```
