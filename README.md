<p align="center">
  <img src="packages/web/public/limi-icon.png" alt="Limi：薄荷绿背景上的奶油白小海蛞蝓，带橙色触角和微笑" width="160" />
</p>

<h1 align="center">Limi</h1>

<p align="center">a simple way to manage agents</p>

Limi 是一个 agent 管理工作台。把远程主机上的 Claude Code、Codex、pi、Antigravity 等 coding agent 集中到浏览器里，统一查看和管理。

打开网页就能：

- 看每个 agent 在做什么——进展、审批、用量
- 随时发消息、补充要求、处理审批
- 一处管理多个 agent 和多台机器

Limi 不动 agent 本身的目录、配置和会话，装好即用。名字来自 Limacia 海蛞蝓，图标是一只带橙色短触角、奶油白身体的小伙伴，配上浅薄荷绿背景，希望工作台也能轻松、亲切一些。

## 界面预览

| 桌面 · 亮色 | 桌面 · 深色 |
|---|---|
| ![桌面亮色](docs/screenshots/desktop-light.png) | ![桌面深色](docs/screenshots/desktop-dark.png) |

| 手机 · 亮色 | 手机 · 深色 |
|---|---|
| ![手机亮色](docs/screenshots/phone-light.png) | ![手机深色](docs/screenshots/phone-dark.png) |

> 状态：可用，正在迭代。要做的事见 [docs/TODO.md](docs/TODO.md)，架构见 [docs/PLAN.md](docs/PLAN.md)。

## 已支持

| Agent | 接入方式 | 审批 | 发图片 | 导入历史 / 分叉 |
|---|---|---|---|---|
| Claude Code | ACP（`@agentclientprotocol/claude-agent-acp`，随项目安装） | 有 | 有 | 有 |
| pi | `pi --mode rpc` | 无（pi 本身没有） | 有。纯文本模型需要装 pi 扩展 `pi-aux-vision` | 有 |
| Antigravity | `agy` 的无界面 stream-json 模式 | 无（不能询问，只有"自动改文件"和"完全访问"两档） | 有（按文件路径交给它） | 暂无 |
| Codex | `codex app-server` | 有 | 有 | 有 |

pi 和 agy 要先在主机上装好并登录。没装的 agent 在界面里显示为不可用。

## 快速开始

需要 Node.js 22 或更高版本。

```bash
npm install
cp .env.example .env          # 在项目根目录，编辑 RAH_TOKEN（至少 16 位）和 RAH_WORKDIRS
npm run build
RAH_ENV_FILE=../../.env npm start -w @rah/daemon    # 默认监听 127.0.0.1:8787
```

打开 `http://127.0.0.1:8787/`，输入 `RAH_TOKEN`。

开发时可以分开启动：

```bash
RAH_ENV_FILE=../../.env npm run dev:daemon   # 后端
npm run dev:web                              # Vite，http://127.0.0.1:5173，/api 代理到后端
```

daemon 在 `packages/daemon` 目录里运行，所以用 `RAH_ENV_FILE` 指向根目录的 `.env`。没有设置 `RAH_ENV_FILE` 时，读取的是当前目录下的 `.env`。

## 远程访问

- 默认只监听 `127.0.0.1`。
- 远程使用时，通过 VPN 访问。把 `RAH_HOST` 设为 VPN 网卡的地址，不要设为 `0.0.0.0`。
- 使用 HTTP + token。VPN 已加密传输，项目不额外处理证书。
- 注意：`http://<IP>` 不是安全上下文，因此 PWA 的离线缓存和"添加到主屏幕"不可用，网页里的"拷贝"按钮需要降级处理。

## 管理另一台机器

浏览器只连主 hub；主 hub 通过 SSH 隧道访问另一台机器上的 daemon。线程、文件和 agent 都留在各自机器上。

1. **目标机器**：按上面的快速开始安装、配置并构建，再用 `scripts/install-service.sh` 启动服务。保持默认的私有 socket，不必对外开放 HTTP 端口。
2. **主 hub**：以 daemon 的运行用户配置 SSH 别名和凭据，先手动连接、核实主机密钥，再确认 `ssh -o BatchMode=yes <SSH别名> true` 能成功。服务需要能持续免交互认证；只在当前终端可用的 ssh-agent 或临时票据不一定能被服务使用。
3. **浏览器**：打开「配置 → 机器」，从 SSH 别名列表添加，或输入别名 / `user@host`。成功后在线程列表顶部切换机器。

添加流程读取的是 **hub 所在机器**的 SSH 配置，不是手机或电脑浏览器的配置。目标上的 daemon 要先启动；第一期不自动安装和启动。远端 daemon 负责调用该机器上的 agent、读取会话与文件，浏览器仍只访问主 hub；远端无需单独部署前端或开放 HTTP 端口。

更新主 hub 不会自动更新远端 daemon，每台机器需要分别更新。源码安装先同步代码、安装依赖，再运行 `scripts/restart.sh` 构建并等待线程空闲后重启；仅安装运行包的机器需要同步新版 daemon 构建产物，依赖有变化时安装生产依赖，再运行 `scripts/restart.sh --no-build`。保留原有配置和数据目录即可保留 token、线程与会话。涉及新接口的功能（例如新建接手对话）需要目标机器的 daemon 也更新。

| 配置 | 默认与用途 |
| --- | --- |
| `RAH_SOCKET` | 默认 `~/.local/state/remote-agent-hub/daemon.sock`；`off` 关闭私有监听。自定义路径用于隔离实例，当前远端发现只支持默认路径 |
| `RAH_SSH_BIN` | 默认 PATH 中的 `ssh`，用于主 hub 连接其他机器 |

私有 socket 依赖文件权限和 SSH 认证，免 token。主 hub 的 token 因此能操作所有已添加的机器。移除机器只断开连接，远端线程继续保留。连不上时，机器面板会显示原因；常见原因是服务环境缺少 SSH 凭据、未知主机密钥、目标 daemon 没启动或 sshd 不允许 Unix socket 转发。架构与限制见 [多机管理设计](docs/multi-host-design.md)。

## 开机自启

应用已更名为 Limi。为兼容已有安装，systemd 服务名、配置与数据目录、私有 socket 路径以及 `RAH_*` 环境变量沿用原标识 `remote-agent-hub`，升级时不迁移已有会话。

```bash
scripts/install-service.sh              # 装成 systemd 用户服务并启动；默认读 ~/.config/remote-agent-hub/.env
scripts/install-service.sh --remove     # 停止并移除
journalctl --user -u remote-agent-hub -f
```

服务通过登录 shell 启动，所以 agent 能拿到你在 shell 配置里设置的 API key。不登录也要在开机时启动，需要执行一次 `loginctl enable-linger $USER`。

更新代码后用 `scripts/restart.sh` 重启：先构建，构建失败就不动正在跑的服务；再等所有线程跑完这一轮，然后重启并检查健康状态。`--force` 不等，正在跑的那一轮会以错误结束。在 hub 的线程里由 agent 调用时，脚本会在后台等，等包括它自己在内的所有线程都空闲后再重启，日志在 `~/.local/state/remote-agent-hub/restart.log`。

## 发布前检查

```bash
npm run check:publish
```

扫描会被发布的文件，查找你的用户名、主机名、家目录路径、内网 IP、长密钥、邮箱地址。公司名、项目名这类私人词放在仓库外的 `~/.config/remote-agent-hub/publish-denylist`（每行一个），也会一起检查。

## 目录结构

```
packages/daemon   网关：HTTP/SSE API、鉴权、SQLite 存储、各 agent 的适配器
packages/web      界面：React + Vite，手机与桌面共用一套组件
docs/             计划与界面说明
```

## 开发

```bash
npm test          # daemon 与 web 的全部单元测试和 API 测试
npm run typecheck
```

测试不需要真实的模型账号：适配器测试使用 `packages/daemon/test/fixtures` 里的假 agent 进程。

## 安全

- HTTP 监听上的 API 需要 `Authorization: Bearer <RAH_TOKEN>`，`/api/health` 除外；仅本机用户能访问的私有 Unix socket 免 token，由文件权限和 SSH 认证保护。
- daemon 等同于远程 shell。只把它暴露在可信网络（VPN）中。
- 工作目录必须在 `RAH_WORKDIRS` 白名单内。

## 许可证

[MIT](LICENSE)

### 安装为桌面应用

在 Chrome 中打开 Limi 后，可通过浏览器菜单将它安装为应用。安装名称为 Limi，图标使用 Limacia 小海蛞蝓。

如果此前安装的应用仍显示 AgentHub 或默认字母图标，先尝试关闭所有应用窗口后重新打开，并接受 Chrome 提供的名称或图标更新。如果仍未更新，可卸载旧应用后从当前网页重新安装；卸载时不要勾选清除网站数据，以保留本机登录和偏好。
