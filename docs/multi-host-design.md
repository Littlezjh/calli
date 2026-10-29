# 多机管理设计

2026-10-12 · 第一期已实现，实机验收待完成。

## 已定方案

每台机器运行同一个 daemon，其中一台作为浏览器连接的主 hub。主 hub 通过 SSH 隧道访问其他机器的私有 Unix socket；SSH 负责认证与加密，不保存远端 token，不使用配对码。

SSH 只负责把 HTTP 和 SSE 转过去。agent、工作目录、图片、线程、事件日志和计划仍由目标机器自己的 daemon 管理，断开隧道不会终止 agent 会话。浏览器一次查看一台机器，没有合并的「全部」列表。

最初考虑过节点主动连出，这保留为后续连接方式，适合笔记本、NAT 后的机器以及无法提供长期免交互 SSH 认证的环境。第一期选择 SSH，是为了复用已有的 SSH 配置与信任关系。

## 结构

```text
浏览器
   │ HTTP + SSE，主 hub 的 token
   ▼
主 hub daemon
   ├─ 本机 agent、线程与文件
   └─ hosts.ts：机器登记、状态、SSH 隧道、流式代理
         │ ssh -L 本地.sock:远端.sock
         ▼
另一台机器的私有 Unix socket（免 token）
   └─ daemon：那台机器自己的 agent、线程与文件
```

- 浏览器只连主 hub 的地址；SSH 由主 hub 的 daemon 发起，使用它运行用户的 SSH 配置和凭据。
- 目标机器需要提前安装并启动 daemon，第一期不代装、也不通过 SSH 拉起 daemon。
- 目标机器的 HTTP 页面与 token 仍可独立使用。主 hub 不可用时，可以直接访问它。
- 私有 socket 不提供机器管理接口，不支持嵌套转发。
- 旧的 `docs/design/multi-host.png` 是节点连出方案的草图，不代表当前实现。

## 添加与连接

1. 在目标机器按 README 配置 daemon，用 `scripts/install-service.sh` 安装用户服务。
2. 在主 hub 上，以 daemon 的运行用户确认 SSH 能免交互连接目标，并事先确认主机密钥。
3. 打开「配置 → 机器」，选 SSH 配置里的别名，或输入别名 / `user@host`。
4. hub 经 SSH 探测目标用户家目录下的 socket，拿到绝对路径后建立隧道，再请求 `/api/health` 确认 daemon 有应答。

默认 socket 是 `~/.local/state/calli/daemon.sock`，刻意不随 `XDG_STATE_HOME` 变化：SSH 登录命令和服务启动环境可能不同。`CALLI_SOCKET=off` 关闭监听；自定义路径可用于隔离测试，但当前添加流程只发现默认路径。`CALLI_SSH_BIN` 可覆盖主 hub 使用的 SSH 命令。

机器记录存在数据目录的 `hosts.json`，权限 `0600`，只有 ID、显示名、SSH 目标与 socket 路径，没有密钥。候选列表读取 `~/.ssh/config` 的明确别名及 `Include` 文件，跳过通配别名；实际连接参数由 OpenSSH 解释。

## 信任边界

- 浏览器到主 hub 的 API 仍验证 token，健康检查除外。主 hub 的 token 可以操作所有已添加机器，应当按远程 shell 的凭据保护。
- 每个 daemon 的私有 socket 目录和 socket 权限为 `0700`，创建时用 umask 限制权限。从该 socket 进入的请求免 token，依赖本机用户权限与 SSH 认证。
- 主 hub 转发时去掉自己的 Authorization，不把浏览器 token 交给远端；逐跳头也不转发。
- SSH 使用 `BatchMode=yes`，不交互询问密码，不替用户接受未知主机密钥。沿用用户自己的 SSH 主机密钥策略。
- 目标机器的工作目录白名单和 agent 配置继续生效。移除机器只删除登记并关闭隧道，不删除远端线程或停止 agent。
- 浏览器到 hub 仍应走可信网络（VPN）；SSH 只加密 hub 到目标机器这一段。

## 生命周期与故障

每台已登记机器持有一个 SSH 子进程。隧道会话报告就绪后等待标准输入结束；hub 退出或被强制终止时，输入管道关闭，隧道随之退出。连接不复用可能长于 hub 生命周期的 SSH ControlMaster。

隧道断开后从 2 秒开始退避重连，最长 2 分钟；后台重试保持「离线」，不反复闪成「连接中」。也可以手动「重试」。连接成功后每 15 秒检查远端健康，页面每 10 秒刷新机器表；当前页面的代理失败也会触发健康检查。

| 失败码 | 含义与处理 |
| --- | --- |
| `no_ssh` | hub 没有 SSH 命令，安装或配置 `CALLI_SSH_BIN` |
| `host_key` | 主机密钥未知或变化，先在 hub 上手动连接并核实 |
| `auth` | 无法免交互登录，检查 daemon 运行用户的 SSH 凭据 |
| `unreachable` | DNS、网络或超时问题 |
| `ssh_failed` | 其他 SSH 错误，查看界面显示的原始原因 |
| `daemon_missing` | socket 未发现或 daemon 没应答；也可能是 sshd 禁止 socket 转发 |
| `forward_denied` | sshd 明确报告禁止转发 |

OpenSSH 对 socket 无人监听和部分转发禁令会给出相同错误，不能总是区分。只有 Kerberos 的环境还需验证凭据到期后的重连能力，不能把一次登录成功当作常驻连接已可靠。

## 接口与传输

以下接口都在主 hub 上，需要主 hub token：

| 接口 | 用途 |
| --- | --- |
| `GET /api/hosts` | 机器列表、连接状态与失败原因 |
| `GET /api/hosts/candidates` | 尚未添加的 SSH 别名 |
| `POST /api/hosts`，`{ target, label? }` | 探测并登记机器，返回连接状态 |
| `DELETE /api/hosts/:id` | 移除并断开隧道 |
| `POST /api/hosts/:id/reconnect` | 立即重新连接 |
| `* /api/hosts/:id/proxy/…` | 原样转到目标 daemon 的 `/api/…` |

请求体和响应通过 pipe 流式传输，支持并发 HTTP 请求和长时间 SSE，不在 hub 缓存整条消息。浏览器取消请求时，上游请求也关闭。事件续传仍用 `after=<seq>`，不增加另一套消息协议。

## 界面与状态

- 没有其他机器时不显示切换条；添加后在线程列表顶部显示「本机」和已登记机器。
- 切换机器时重新挂载 App，API 前缀、线程、agent、目录、额度、计划、终端一起切换。手机切换后仍停在线程列表。
- 当前机器保存在设备的 `calli.host`；当前机器被移除后回到本机。
- 对话顶栏副标题显示机器名；草稿按机器和线程隔离，本机保留原有草稿键。
- 离线时主区显示原因和「重试」，隐藏输入框；列表提示等待连接，不把空列表解释成线程已删除。尚未缓存离线线程。
- 「配置 → 机器」提供添加、失败说明、重试、移除确认。第一期没有重命名与跨机器汇总。

## 验证与后续

已用假 SSH 和两份独立 daemon 验证接口、线程与 SSE、连接失败分类、重连和权限；真实 OpenSSH 的本机隔离试验验证过 40 MB 请求、实时 SSE、10 路并发、隧道中断及 hub 强退后的清理。它们不替代目标机器上的部署验收。

实机验收需确认：hub 的服务环境能免交互 SSH、目标默认 socket 可用、sshd 允许 Unix socket 转发、持续连接和断线重连正常。测试与界面验收的当前结果见 `TODO.md`。

后续独立迭代：

- 协议版本与能力协商，避免各机器分别升级时接口不兼容。
- 重命名、离线线程缓存与变暗、机器状态推送。
- 经 SSH 启动尚未运行的 daemon。
- 「全部」线程列表、跨机器未读与计划关联。
- 节点主动连出，支持笔记本和不适合长期 SSH 的环境。
