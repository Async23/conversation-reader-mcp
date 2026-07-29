# Security policy

## Reporting a vulnerability

Please do not open a public issue for a vulnerability, access token, cookie,
private conversation, or other sensitive material.

Use GitHub's **Security → Report a vulnerability** flow for this repository.
Include only the minimum reproduction data and replace all real credentials
with test values.

We aim to acknowledge a complete report within seven days. Fix timing depends
on severity, reproducibility, and upstream behavior. Please allow time for a
coordinated fix before public disclosure.

## Supported versions

Only the latest published version receives security fixes.

## Local trust boundary

AI clients start a pinned stdio connector command. The connector starts the
shared HTTP daemon only for a tool call; the daemon is limited to loopback,
protected with a generated Bearer token, and exits after the configured idle
period. The ChatGPT access token and daemon Bearer token remain in the private
local service config and are not copied into AI client configs. Reports that
require binding the daemon to a LAN or public interface are outside the
supported security model.

Conversation assets are resolved only after their opaque id is found on the
active visible branch of the requested conversation. Downloads have a byte
limit and MIME checks. Cross-origin signed download URLs must use HTTPS and
never receive the ChatGPT access token; same-origin URLs may reuse it. Signed
URLs are not returned in MCP results or error messages.
