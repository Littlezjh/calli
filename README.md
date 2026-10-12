# Remote Agent Hub

在远程主机上运行 coding agent，通过手机或电脑浏览器使用。界面参考 Codex 的版式，但功能更少，目标是简单、不干扰 agent。

> 状态：可用，正在迭代。要做的事见 [docs/TODO.md](docs/TODO.md)，架构见 [docs/PLAN.md](docs/PLAN.md)。

## 已支持

| Agent | 接入方式 | 审批 | 发图片 | 导入历史 / 分叉 |
|---|---|---|---|---|
| Claude Code | ACP（`@agentclientprotocol/claude-agent-acp`，随项目安装） | 有 | 有 | 有 |
| pi | `pi --mode rpc` | 无（pi 本身没有） | 有。纯文本模型需要装 pi 扩展 `pi-aux-vision` | 有 |
| Antigravity | `agy` 的无界面 stream-json 模式 | 无（不能询问，只有"自动改文件"和"完全访问"两档） | 有（按文件路径交给它） | 暂无 |
| Codex | `codex app-server` | 计划中 | | |

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

## 开机自启

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

- 所有 API 需要 `Authorization: Bearer <RAH_TOKEN>`，`/api/health` 除外。
- daemon 等同于远程 shell。只把它暴露在可信网络（VPN）中。
- 工作目录必须在 `RAH_WORKDIRS` 白名单内。

## 许可证

[MIT](LICENSE)
