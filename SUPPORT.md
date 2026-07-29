# Support

## 使用问题

先运行：

```bash
npx -y read-my-chatgpt@latest doctor --json
```

然后查看 [README](README.md) 中的初始化、token 更新、诊断与卸载说明。

仍无法解决时，可以提交 Bug Issue。请只提供：

- 操作系统、CPU 架构和 Node.js 版本；
- `read-my-chatgpt` 版本；
- 使用的 AI 客户端及版本；
- 最小复现步骤；
- 已脱敏的 `doctor --json` 输出和错误信息。

不要提交 access token、MCP Bearer token、cookie、私人会话、完整配置文件或未经
检查的日志。

## 安全问题

漏洞或任何包含敏感数据的问题，请勿创建公开 Issue。请按
[SECURITY.md](SECURITY.md) 使用 GitHub 私密漏洞报告。

## 支持范围

项目只支持 README 中明确列出的：

- macOS / Linux 本机部署；
- 本机 stdio connector 与按需 loopback daemon；
- 个人账号的只读 Chat 会话及已完成云端 Work 会话访问；
- 当前可见消息中的链接、搜索引用、Mermaid 源码、图片和普通文件附件；
- 最新发布版本。

Windows `init`、局域网/公网暴露、团队工作区、写操作和绕过上游限制不在
支持范围内。运行中 Work 的实时进度、Scheduled Tasks、Canvas/交互预览、
Apps、Work Sites 和外部云文档运行时也不在当前支持范围内。
