# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)。

## [Unreleased]

### Added

- Add `READ_MY_CHATGPT_OUTPUT_TIMEZONE` for RFC 3339 conversation timestamps
  in a validated IANA timezone, including daylight-saving offsets.
- Add formatted `created_at` / `updated_at` fields and explicit `time_zone`
  metadata to conversation list and search results while retaining upstream
  timestamp fields for compatibility.
- Advertise the configured timestamp semantics through MCP server instructions
  and tool descriptions.

## [0.3.0] - 2026-07-23

### Added

- Classify ChatGPT conversations as `chat`, `work`, or `unknown` from live Web
  response signals.
- Read completed Work conversation dialogue while omitting hidden agent events,
  internal reasoning, and tool execution.
- Expose conversation experience and completion status through MCP results.
- Extract structured links, web citations, Mermaid source, images, and ordinary
  file attachments from visible conversation messages.
- Add `get_asset` for size-limited, MIME-checked MCP image/resource delivery
  without exposing signed upstream download URLs.

### Fixed

- Wait for an existing launchd process to exit before bootstrapping a replacement
  during same-service upgrades.
- Treat decoded asset bytes as authoritative when HTTP content encoding makes the
  transfer length differ from the delivered file size.

## [0.2.1] - 2026-07-21

### Fixed

- Wait for the legacy launchd process to finish flushing Obscura profile data
  before moving installation directories.
- Remove an emptied legacy config directory after a conflict-safe migration.

## [0.2.0] - 2026-07-21

### Changed

- Adopted `read-my-chatgpt` as the GitHub repository, npm package, CLI,
  MCP server, and local service name.
- Added automatic migration from `conversation-reader-mcp` service files,
  local data, logs, and AI client entries.

## [0.1.1] - 2026-07-21

### Added

- Public contribution, support, issue, and pull request guidance.
- Cross-platform packaged CLI lifecycle verification.
- Dependency update and code-scanning automation.

### Security

- Hardened GitHub Actions and release checks.
- Eliminated regex backtracking on untrusted `Authorization` headers.

## [0.1.0] - 2026-07-20

### Added

- One local Streamable HTTP MCP server shared by supported AI clients.
- Managed Obscura sidecar with pinned version, size, and SHA-256 verification.
- macOS launchd and Linux systemd user service setup.
- Automatic configuration for Codex, Claude Code, Cursor, Gemini CLI, Grok
  CLI, OpenCode, and Pi.
- Read-only conversation listing, retrieval, and title search tools.

[Unreleased]: https://github.com/Async23/read-my-chatgpt/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Async23/read-my-chatgpt/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/Async23/read-my-chatgpt/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Async23/read-my-chatgpt/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Async23/read-my-chatgpt/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Async23/read-my-chatgpt/releases/tag/v0.1.0
