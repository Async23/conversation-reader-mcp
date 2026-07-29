# Read My ChatGPT

[![CI](https://github.com/Async23/read-my-chatgpt/actions/workflows/ci.yml/badge.svg)](https://github.com/Async23/read-my-chatgpt/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Async23/read-my-chatgpt/actions/workflows/codeql.yml/badge.svg)](https://github.com/Async23/read-my-chatgpt/actions/workflows/codeql.yml)
[![npm](https://img.shields.io/npm/v/read-my-chatgpt)](https://www.npmjs.com/package/read-my-chatgpt)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

把你自己的 ChatGPT Web 会话历史，以只读 MCP tools 提供给本机多个
AI 客户端。一个后台 MCP server 共享一个 Obscura 浏览器进程，不会为每个
客户端重复启动。

> [!WARNING]
> 本项目使用 ChatGPT 的非公开 Web endpoint，不是 OpenAI 官方产品，也未获
> OpenAI 认可或赞助。OpenAI 的使用条款限制自动或程序化提取数据或 Output；
> 请先确认你的使用场景获得允许，并自行承担账号与合规风险。

## 两条命令开始

要求 Node.js 22 或更高版本。一键后台服务支持：

| 操作系统 | CPU | 要求 |
|---|---|---|
| macOS | arm64、x64 | launchd |
| Linux | arm64、x64 | systemd user、glibc 2.35+ |

Windows、Alpine/musl 暂不支持一键后台服务；仍可自行提供兼容的 Obscura 并
使用 stdio 模式。

```bash
npm install -g read-my-chatgpt
read-my-chatgpt setup
```

`setup` 会：

1. 隐藏输入你的 ChatGPT Web access token；
2. 从 Obscura 官方 GitHub Release 下载固定版本 `v0.1.10`，并校验
   SHA-256；
3. 生成本机 MCP Bearer token，写入权限为 `0600` 的配置文件；
4. 安装一个 launchd（macOS）或 systemd user（Linux）后台服务；
5. 自动配置检测到的 Codex、Claude Code、Cursor、Gemini CLI、Grok CLI、
   OpenCode 和 Pi。

首次运行会先要求确认风险。自动化安装需同时显式设置环境变量并确认：

```bash
READ_MY_CHATGPT_ACCESS_TOKEN='…' read-my-chatgpt setup --yes
```

完成后重启一次 AI 客户端。它们会共同连接：

```text
http://127.0.0.1:47831/mcp
```

服务只允许 loopback，不会监听局域网或公网。

## 从旧包迁移

如果本机安装过 `conversation-reader-mcp`：

```bash
npm install -g read-my-chatgpt
read-my-chatgpt setup --yes
npm uninstall -g conversation-reader-mcp
```

`setup` 会停止旧后台服务，把原有 token、Obscura、浏览器 profile 和日志迁移到
`read-my-chatgpt` 路径，并把 AI 客户端中的 `conversation-reader` 条目替换为
`read-my-chatgpt`。正常迁移不需要重新输入 token。

## 获取 access token

1. 登录 [chatgpt.com](https://chatgpt.com/)；
2. 打开开发者工具的 Network；
3. 找到任意 `/backend-api/*` 请求；
4. 复制 `Authorization: Bearer …` 中 `Bearer ` 后面的内容。

token 会过期。失效后重新运行 `read-my-chatgpt setup` 输入新 token，
后台服务和客户端配置会一起更新。

不要把 token 提交到 Git、Issue、日志或聊天消息中。

## 输出时区

MCP 默认以 UTC 输出 RFC 3339 时间，以保持现有调用兼容。若希望 AI 直接使用
本地时间，可设置 IANA 时区并重新运行 `setup`：

```bash
READ_MY_CHATGPT_OUTPUT_TIMEZONE=Asia/Shanghai read-my-chatgpt setup --yes
```

已有安装会复用原来的 access token；后续再次运行 `setup` 也会保留这个配置。
源码或 stdio 模式同样读取 `READ_MY_CHATGPT_OUTPUT_TIMEZONE`。例如上海时区会
输出：

```text
2026-07-24T15:58:07.513+08:00
```

`get_conversation` 的 `created_at`、`updated_at` 和
`messages[].created_at` 会使用配置时区。`list_conversations` 和
`search_conversations` 继续保留上游 `create_time` / `update_time` 字段，
同时新增适合展示的 `created_at` / `updated_at`。包含时间的工具结果还会返回
`time_zone`，MCP instructions 会要求客户端优先使用格式化字段。

该配置只控制 MCP 时间输出；`READ_MY_CHATGPT_OBSCURA_TIMEZONE` 控制浏览器
sidecar，两者用途不同。

## 日常命令

```bash
# 检查 Node、配置权限、Obscura、后台服务和 HTTP endpoint
read-my-chatgpt doctor

# 输出便于脚本读取的诊断结果（不包含任何 token）
read-my-chatgpt doctor --json

# 再次配置已检测到的客户端
read-my-chatgpt configure

# 指定客户端；也可以用 all 创建全部 7 份配置
read-my-chatgpt configure codex cursor gemini
read-my-chatgpt configure all

# 停止服务并从客户端移除 MCP 条目；默认保留 token 与浏览器 profile
read-my-chatgpt uninstall

# 同时删除本项目保存的配置、token、Obscura 和 profile
read-my-chatgpt uninstall --purge
```

修改客户端配置前会创建 `.bak` 备份；若 `.bak` 已存在，则创建带时间戳的新
备份。因为客户端配置中会加入 MCP Bearer token，修改后的文件及备份都会
收紧为 `0600`。

## 支持的客户端

| 客户端 | 默认配置文件 | 形式 |
|---|---|---|
| Codex | `~/.codex/config.toml` | Streamable HTTP `url` + `http_headers` |
| Claude Code | `~/.claude.json` | `type: "http"` + `url` + `headers` |
| Cursor | `~/.cursor/mcp.json` | `url` + `headers` |
| Gemini CLI | `~/.gemini/settings.json` | `httpUrl` + `headers` |
| Grok CLI | `~/.grok/config.toml` | `url` + `headers` |
| OpenCode | `~/.config/opencode/opencode.json` | `type: "remote"` |
| Pi | `~/.pi/agent/mcp.json` | `pi-mcp-adapter` remote 配置 |

Pi 本身不内置 MCP；先执行 `pi install npm:pi-mcp-adapter`。`setup` 检测到该
adapter 后才会自动写入 Pi 配置。

其他支持 Streamable HTTP 的 MCP 客户端可手动使用：

```json
{
  "url": "http://127.0.0.1:47831/mcp",
  "headers": {
    "Authorization": "Bearer <service.json 中生成的值>"
  }
}
```

Bearer token 保存在
`~/.config/read-my-chatgpt/service.json`。不要把该文件分享给别人；
分享的是 npm 包或 GitHub 仓库，不是你的本机配置。

## MCP tools

| Tool | 用途 |
|---|---|
| `list_conversations` | 分页列出 Chat / Work 会话元数据和 `experience` |
| `get_conversation` | 读取当前活跃分支的可见文本及结构化链接、引用、Mermaid、图片/附件索引 |
| `get_asset` | 用 `get_conversation` 返回的 `asset_id` 读取图片或普通附件本体 |
| `search_conversations` | 按标题子串搜索并返回 `experience` |

`get_conversation` 保留原有 `messages[].content` 文本字段；仅在消息含有富内容时
增加 `messages[].rich_content`：

```json
{
  "links": [{ "kind": "web", "url": "https://…", "title": "…" }],
  "citations": [{ "url": "https://…", "title": "…", "reference_type": "sources_footnote" }],
  "diagrams": [{ "format": "mermaid", "source": "graph TD\n  A --> B" }],
  "assets": [{
    "asset_id": "asset_…",
    "kind": "image",
    "name": "chart.png",
    "mime_type": "image/png",
    "size_bytes": 1234,
    "width": 1024,
    "height": 768
  }]
}
```

读取图片/附件需要把同一个 `conversation_id` 和上面的 `asset_id` 传给
`get_asset`。图片以 MCP `image` content 返回；其他文件以带 Base64 blob 的
MCP embedded `resource` 返回。默认单个资产上限为 10 MiB，可用
`READ_MY_CHATGPT_MAX_ASSET_BYTES` 调整（最大 32 MiB）。

边界：

- 只读，不发送、修改、归档或分享会话；
- 读取 live Web 数据，不创建本地会话归档；
- 支持读取已完成的云端 Work 会话；返回 `experience` 和
  `completion_status`，隐藏内部推理、子代理事件与工具执行；
- 支持当前可见消息直接引用的图片与普通文件附件；
- 不跟踪运行中的 Work，也不复现 Canvas/HTML/React 预览、Apps 卡片、
  Work Sites、Google Docs/Sheets/Slides 或其他交互运行时；
- `search_conversations` 只搜索标题；
- 只处理个人账号，不添加 Team/Workspace headers；
- token 过期后需要手动更新。

## 架构

```text
Codex / Claude / Cursor / Gemini / Grok / OpenCode / Pi
                         │
             Streamable HTTP + Bearer
                         │
             127.0.0.1:47831/mcp
                         │
             1 个 Node MCP singleton
                         │
             1 个 Obscura sidecar
                         │
       chatgpt.com/backend-api（只读白名单）
```

每个客户端有独立 MCP session，但共享同一个上游浏览器 runtime。ChatGPT
access token 只经本机 CDP 注入页面内 XHR，不放进 Obscura argv 或日志。

允许的上游 endpoint 只有：

```text
GET /backend-api/conversations
GET /backend-api/conversation/{id}
GET /backend-api/files/download/{file_id}?conversation_id={id}&inline=false
```

最后一个 endpoint 只为已经出现在该会话当前可见分支中的 `asset_id` 获取一次性
下载地址。随后只访问上游返回的 HTTPS 资产地址；只有与配置的 ChatGPT
`baseUrl` 同源时才携带现有 access token，跨域下载绝不携带。签名地址不会出现
在 MCP 返回值或错误信息中。下载前后都会执行大小限制，并校验 MIME；HTML
响应和“图片却返回非图片 MIME”会被拒绝。

## 隐私与本机文件

默认位置：

```text
~/.config/read-my-chatgpt/service.json
~/.local/share/read-my-chatgpt/obscura/
~/.local/share/read-my-chatgpt/obscura-profile/
```

`service.json` 含 access token 与 MCP Bearer token；
`obscura-profile/` 可能含 cookie 和 localStorage，两者都应按账号敏感数据保护。
项目不提供云端中转，也不会遥测上传这些数据。

macOS 日志位于
`~/Library/Logs/read-my-chatgpt{,.error}.log`。Linux 使用：

```bash
journalctl --user -u read-my-chatgpt.service
```

## 兼容 stdio

旧客户端可直接启动 CLI；这种模式不会提供“全客户端单例”：

```bash
export READ_MY_CHATGPT_ACCESS_TOKEN='…'
read-my-chatgpt
```

首次启动仍会自动下载并校验 Obscura。也可以指定已有的兼容版本：

```bash
export READ_MY_CHATGPT_OBSCURA_BIN='/absolute/path/to/obscura'
```

## 从源码开发

```bash
git clone https://github.com/Async23/read-my-chatgpt.git
cd read-my-chatgpt
npm ci
npm run check
```

需要真实账号联调时：

```bash
export READ_MY_CHATGPT_ACCESS_TOKEN='…'
npm run smoke
npm run smoke:stability
```

## 安全与依赖

- 安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。
- Obscura 由其官方 Release 在首次 setup 时单独下载，不包含在 npm tarball 中；
  版本、校验值和许可证信息见
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- OpenAI 使用条款与品牌规范可能变化，请以
  [Terms of Use](https://openai.com/policies/terms-of-use/) 和
  [Brand guidelines](https://openai.com/brand/) 为准。

## 参与和支持

- 使用问题与脱敏要求：[SUPPORT.md](SUPPORT.md)
- 贡献流程与本地检查：[CONTRIBUTING.md](CONTRIBUTING.md)
- 安全漏洞私密报告：[SECURITY.md](SECURITY.md)
- 行为准则：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- 版本变化：[CHANGELOG.md](CHANGELOG.md)

## License

[MIT](LICENSE)
