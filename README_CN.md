# tlive

[![npm version](https://img.shields.io/npm/v/tlive)](https://www.npmjs.com/package/tlive)
[![CI](https://github.com/y49/tlive/actions/workflows/ci.yml/badge.svg)](https://github.com/y49/tlive/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.md)

**Terminal Live** — 从 Telegram、Discord、飞书监控和操控 AI 编码工具（Claude Code、Codex）。

三大功能，按需组合：

| 功能 | 说明 | 访问方式 |
|------|------|---------|
| **Web 终端** | `tlive <cmd>` — 包装任何命令，手机浏览器访问 | 浏览器 / 手机 |
| **IM 桥接** | `/tlive` — 在手机上与 Claude Code 双向对话 | Telegram / Discord / 飞书 |
| **Hook 审批** | 在手机上审批 Claude Code 工具权限 | Telegram / Discord / 飞书 |

<!-- TODO: 添加演示截图/GIF -->
<!-- ![tlive 演示](docs/images/demo.gif) -->

## 快速开始

```bash
# 1. 安装
npm install -g tlive

# 2. 配置 IM 平台（交互式引导）
tlive setup

# 3. 注册 hooks + Claude Code 技能
tlive install skills

# 4. 在 Claude Code 中启动桥接
/tlive
```

> **推荐：** 在 Claude Code 中运行 `/tlive setup`，AI 会一步步引导你完成配置。

平台配置指南：[Telegram](docs/setup-telegram-cn.md) · [Discord](docs/setup-discord-cn.md) · [飞书](docs/setup-feishu-cn.md) · [完整入门指南](docs/getting-started-cn.md)

## Web 终端

包装长时间运行的命令，手机浏览器远程访问。

```bash
tlive claude                  # 带 Hook 审批上下文包装 Claude Code
tlive python train.py         # 包装训练脚本
tlive npm run build           # 包装构建
```

```
$ tlive claude --model opus

  TLive Web UI:
    Local:   http://localhost:4590?token=abc123
    Network: http://192.168.1.100:4590?token=abc123
  Session: claude (ID: a1b2c3)
```

多会话共享仪表盘。Daemon 自动启动，空闲 15 分钟自动退出。

<!-- TODO: 添加 Web 终端截图 -->
<!-- ![Web 终端](docs/images/web-terminal.png) -->

## IM 桥接

手机上与 Claude Code 对话。发起新任务，获取实时流式响应和工具可视化。

```
你 (Telegram):    "修复 auth.ts 里的登录 bug"

TLive:  ● Read(auth.ts)
        ● Grep("validateToken" in src/)
        ● Edit(auth.ts)
        ├  Applied
        ● Bash(npm test)
        ├  All 42 tests passed
        ━━━━━━━━━━━━━━━━━━
        Fixed the login bug. The token validation
        was missing the expiry check...
        📊 2m 34s · 12.3k/8.1k tok
```

**详细度控制：** `/verbose 0|1` — 安静（仅最终回复）/ 终端卡片（工具调用 + 结果 + 回复）。

<!-- TODO: 添加 IM 桥接截图 -->
<!-- ![IM 桥接](docs/images/im-bridge.png) -->

## Hook 审批

在手机上审批 Claude Code 工具权限。要走 IM 审批，请从 TLive 管理的终端启动 Claude Code，这样 hook 才能拿到 `TLIVE_SESSION_ID`：

```bash
tlive hooks resume              # 启用 IM 审批
tlive start                     # 启动 Telegram/Discord/飞书 Bridge
tlive claude                    # 带 TLive hook 上下文启动 Claude Code
```

```
Claude Code 运行在 `tlive claude` 里
  │
  ├── Claude 想执行一个命令
  │   → Hook 触发 → Go Core 接收 → Bridge 发送到手机：
  │
  │   🔒 需要权限
  │   工具: Bash
  │   ┌──────────────────────────┐
  │   │ rm -rf node_modules &&   │
  │   │ npm install              │
  │   └──────────────────────────┘
  │   [✅ 允许] [✅ 允许 Bash(npm *)] [❌ 拒绝]
  │
  ├── 你点 [允许] → Claude Code 继续
  │
  └── 离开电脑。Claude 继续工作。
      只有需要审批时手机才会响。
```

**安全设计：**
- Hook 脚本先检查 Go Core 是否运行 — 没运行则直接放行（零影响）
- 如果 Claude Code 不是通过 `tlive <cmd>` 启动，hook 没有 `TLIVE_SESSION_ID`，会直接本地放行
- 一旦 Go Core 接收了 PermissionRequest，超时/错误默认**拒绝**（不是允许）
- 审批前显示具体工具名和命令内容

**坐在电脑旁时暂停：**

```bash
tlive hooks pause              # 自动放行
tlive hooks resume             # 恢复 IM 审批
```

<!-- TODO: 添加 Hook 审批截图 -->
<!-- ![Hook 审批](docs/images/hook-approval.png) -->

## 支持平台

| | Telegram | Discord | 飞书 |
|---|----------|---------|------|
| IM 桥接 | ✅ | ✅ | ✅ |
| Hook 审批 | ✅ | ✅ | ✅ |
| 流式响应 | 编辑消息 | 编辑消息 | CardKit v2 |
| 工具可视化 | ✅ | ✅ | ✅ |
| 输入状态 | ✅ | ✅ | — |
| 权限按钮 | 内联键盘 | Button 组件 | 互动卡片 |
| 内容脱敏 | ✅ | ✅ | ✅ |
| 多引擎 (Claude/Codex) | ✅ | ✅ | ✅ |
| 分级权限按钮 | ✅ | ✅ | ✅ |

## 命令

### CLI

```bash
tlive <cmd>                # Web 终端；Hook 审批请用 `tlive claude`
tlive setup                # 配置 IM 平台
tlive install skills       # 注册 hooks + Claude Code 技能
tlive start                # 启动 Bridge 守护进程
tlive stop                 # 停止守护进程
tlive status               # 查看状态
tlive logs [N]             # 查看最近 N 行日志
tlive doctor               # 运行诊断
tlive hooks                # 查看 Hook 状态
tlive hooks pause          # 暂停 Hook（自动放行）
tlive hooks resume         # 恢复 Hook（IM 审批）
```

### Claude Code 技能

```
/tlive                     # 启动 IM Bridge
/tlive setup               # AI 引导配置
/tlive stop                # 停止 Bridge
/tlive status              # 查看状态
/tlive doctor              # 诊断

/runtime claude|codex          # 切换 AI 引擎
/perm on|off                   # 权限提示
/effort low|medium|high|max    # 思考深度
/stop                          # 中断执行
/verbose 0|1                   # 详细度
/new                           # 新对话
/session                       # 在 Telegram 列出原生 Claude Code 会话
/resume <n|current>            # 在 Telegram 接管原生 Claude Code 会话
/release                       # 在 Telegram 释放原生 Claude 接管
/hooks pause|resume            # 切换 Hook 审批
/help                          # 显示所有命令
```

### Telegram：接续原生 Claude Code 会话

- `/session` — 列出本机最近 5 条原生 Claude Code 会话。
- `/session all` — 列出本机全部原生 Claude Code 会话。
- `/resume <n|current>` — 在 Telegram 接管列表中的会话，或重新接管当前已导入会话。
- `/resume <n|current> cwd "<绝对路径>"` — 接管时覆盖工作目录。
- `/release` — 释放 Telegram 接管，并显示桌面端 `claude --resume <session-id>` 命令。

接管成功后，Telegram 会显示接管工作目录、可用时显示 git 分支、桌面端 resume 命令、租约时间，以及当前 Model/Effort/Perm 状态。默认 Effort 显示为 `xhigh`，但不会主动向 SDK 传 effort；只有显式运行 `/effort` 后才会传入对应设置。

### 响应状态卡片

- 进行中的消息保留工具进度、耗时、todo 和权限提示。
- 最终消息保留耗时和 token 数。
- 最终消息不再显示花费，也不再显示最终工具汇总。

### 本地包测试

不发布到 npm，直接把当前工作区安装成全局 `tlive` 命令：

```bash
tlive stop
npm --prefix bridge run build
npm pack
npm install -g ./tlive-0.8.0.tgz
tlive install skills
tlive version
```

通常不需要先卸载；只有全局路径不对，或 Windows 提示文件被占用时，再运行 `npm uninstall -g tlive`。

## 配置

统一配置文件 `~/.tlive/config.env`（由 `tlive setup` 创建）：

```env
TL_PORT=4590
TL_TOKEN=自动生成
TL_HOST=0.0.0.0
TL_PUBLIC_URL=https://example.com

TL_ENABLED_CHANNELS=telegram,discord
TL_TG_BOT_TOKEN=...
TL_TG_CHAT_ID=...
TL_DC_BOT_TOKEN=...
TL_FS_APP_ID=...
TL_FS_APP_SECRET=...

# Claude Code 配置加载范围（默认 full）
# full = 用户 + 项目 + 本地配置 · user = 仅认证/模型 · isolated = 不加载
TL_CLAUDE_SETTINGS=user,project,local

# 代理（适用于无法直连 Telegram/Discord 的地区）
# TL_PROXY=http://127.0.0.1:7890
```

完整配置项参见 [config.env.example](config.env.example)。

### 远程访问（frp / 内网穿透）

通过 frpc、Cloudflare Tunnel、ngrok 等从外网访问 web terminal：

1. 将本地 `4590` 端口（或你的 `TL_PORT`）通过隧道转发
2. 设置 `TL_PUBLIC_URL` 为隧道域名：
   ```env
   TL_PUBLIC_URL=https://your-domain.com
   ```
   IM 消息中的 web terminal 链接会自动使用该域名，而非局域网 IP。

**安全提示：** 隧道会暴露完整的终端访问权限，务必确保：
- `TL_TOKEN` 已设置（`tlive setup` 会自动生成）— 所有请求需携带此 token
- 已配置 IM 用户白名单（`TL_TG_ALLOWED_USERS`、`TL_DC_ALLOWED_USERS` 等）
- 隧道侧使用 HTTPS（frps / Cloudflare 会自动处理）

## 架构

```
                    ┌──────────────────────┐
                    │   Claude Code (本地)  │
                    │                      │
                    │  PreToolUse Hook ────────────┐
                    │  Notification Hook ──────────┤
                    └──────────────────────┘       │
                                                   ▼
┌─ Go Core (tlive) ───────────────────────────────────────────┐
│                                                              │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────────────┐│
│  │ PTY 管理  │  │ Web UI      │  │ Hook 管理器            ││
│  │ (包装    │  │ (仪表盘 +   │  │ (接收 hooks,           ││
│  │  命令)   │  │  xterm.js)   │  │  长轮询, 解析)         ││
│  └──────────┘  └──────────────┘  └────────────────────────┘│
│                                                              │
│  HTTP API + WebSocket                                        │
└──────────────────────────┬───────────────────────────────────┘
                           │ Bridge 轮询 /api/hooks/pending
                           ▼
┌─ Node.js Bridge ────────────────────────────────────────────┐
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐ │
│  │Claude/Codex │  │ Telegram     │  │ Hook 轮询          │ │
│  │ SDK         │  │ Discord      │  │ (转发到 IM,        │ │
│  │             │  │ 飞书         │  │  点击后解析)        │ │
│  └─────────────┘  └──────────────┘  └────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │  你的手机     │
                    │  (IM 应用)   │
                    └──────────────┘
```

## 开发

```bash
# Go Core
cd core && go build -o tlive ./cmd/tlive/ && go test ./...

# Bridge
cd bridge && npm install && npm run build && npm test
```

### 项目结构

```
tlive/
├── SKILL.md                # Claude Code / Codex 技能
├── config.env.example
├── core/                   # Go → tlive 二进制
│   ├── cmd/tlive/          # CLI（Web 终端、停止、配置、安装）
│   ├── internal/
│   │   ├── daemon/         # HTTP 服务器、会话、Hook 管理器
│   │   ├── server/         # WebSocket 处理
│   │   ├── session/        # 会话状态 + 输出缓冲
│   │   ├── hub/            # 广播中心
│   │   └── pty/            # PTY（Unix + Windows ConPTY）
│   └── web/                # 内嵌 Web UI
├── bridge/                 # Node.js → Bridge 守护进程
│   └── src/
│       ├── providers/      # Claude SDK + Codex SDK providers
│       ├── messages/       # Zod schemas, canonical events, adapters
│       ├── channels/       # Telegram、Discord、飞书适配器
│       ├── engine/         # 会话状态、权限、命令、渲染器
│       ├── permissions/    # 权限网关 + 代理
│       ├── delivery/       # 分块、重试、限速
│       └── markdown/       # 各平台渲染
├── scripts/
│   ├── cli.js              # CLI 入口 + 进程管理
│   ├── hook-handler.mjs    # PermissionRequest hook → Go Core
│   ├── notify-handler.mjs  # Notification hook → Go Core
│   ├── stop-handler.mjs    # Stop hook → Go Core
│   └── statusline.mjs      # Claude Code 状态行
├── package.json            # npm: tlive
└── docker-compose.yml
```

## 安全

- 默认绑定 `0.0.0.0`（局域网可访问，手机扫码直连）
- 自动生成认证 token
- Hook 超时默认**拒绝**（不是允许）
- IM 用户白名单
- IM 消息中自动脱敏 API key、token、密码和私钥
- 日志自动脱敏
- 配置文件 `chmod 600`
- Claude CLI 子进程环境隔离

## 许可证

MIT
