import { canonicalTimeZone } from "./timestamp.js";

export type ChatGPTTransportKind = "obscura" | "direct";
export type McpTransportKind = "stdio" | "http";

export type Config = {
  accessToken: string;
  baseUrl: string;
  outputTimezone: string;
  transport: ChatGPTTransportKind;
  mcpTransport: McpTransportKind;
  mcpHost: string;
  mcpPort: number;
  mcpBearerToken?: string;
  mcpSessionIdleMs: number;
  daemonIdleMs: number;
  obscuraBinary?: string;
  obscuraCdpUrl?: string;
  obscuraStorageDir?: string;
  obscuraTimezone?: string;
  defaultPageSize: number;
  maxPageSize: number;
  defaultMaxMessages: number;
  searchMaxScan: number;
  maxAssetBytes: number;
};

export class ConfigError extends Error {
  readonly code = "config_error";
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const accessToken = (env.READ_MY_CHATGPT_ACCESS_TOKEN ?? "").trim();
  if (!accessToken) {
    throw new ConfigError(
      "Missing READ_MY_CHATGPT_ACCESS_TOKEN. Set it to your ChatGPT web access token (Bearer value without the 'Bearer ' prefix).",
    );
  }

  const baseUrl = (env.READ_MY_CHATGPT_BASE_URL ?? "https://chatgpt.com")
    .trim()
    .replace(/\/+$/, "");
  const transportValue = (
    env.READ_MY_CHATGPT_TRANSPORT ?? "obscura"
  ).trim();
  if (transportValue !== "obscura" && transportValue !== "direct") {
    throw new ConfigError(
      "READ_MY_CHATGPT_TRANSPORT must be 'obscura' or 'direct'.",
    );
  }
  const optionalValue = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value || undefined;
  };
  const requestedOutputTimezone =
    optionalValue("READ_MY_CHATGPT_OUTPUT_TIMEZONE") ?? "UTC";
  let outputTimezone: string;
  try {
    outputTimezone = canonicalTimeZone(requestedOutputTimezone);
  } catch {
    throw new ConfigError(
      "READ_MY_CHATGPT_OUTPUT_TIMEZONE must be a valid IANA timezone such as 'UTC' or 'Asia/Shanghai'.",
    );
  }
  const mcpTransport = (
    env.READ_MY_CHATGPT_MCP_TRANSPORT ?? "stdio"
  ).trim();
  if (mcpTransport !== "stdio" && mcpTransport !== "http") {
    throw new ConfigError(
      "READ_MY_CHATGPT_MCP_TRANSPORT must be 'stdio' or 'http'.",
    );
  }

  const mcpHost = (
    env.READ_MY_CHATGPT_MCP_HOST ?? "127.0.0.1"
  ).trim();
  if (!["127.0.0.1", "localhost", "::1"].includes(mcpHost.toLowerCase())) {
    throw new ConfigError(
      "READ_MY_CHATGPT_MCP_HOST must be a loopback host.",
    );
  }

  const mcpPortValue = (
    env.READ_MY_CHATGPT_MCP_PORT ?? "47831"
  ).trim();
  if (!/^\d+$/.test(mcpPortValue)) {
    throw new ConfigError(
      "READ_MY_CHATGPT_MCP_PORT must be an integer from 1 to 65535.",
    );
  }
  const mcpPort = Number(mcpPortValue);
  if (!Number.isSafeInteger(mcpPort) || mcpPort < 1 || mcpPort > 65_535) {
    throw new ConfigError(
      "READ_MY_CHATGPT_MCP_PORT must be an integer from 1 to 65535.",
    );
  }

  const mcpSessionIdleMsValue = (
    env.READ_MY_CHATGPT_MCP_SESSION_IDLE_MS ?? "1800000"
  ).trim();
  if (!/^\d+$/.test(mcpSessionIdleMsValue)) {
    throw new ConfigError(
      "READ_MY_CHATGPT_MCP_SESSION_IDLE_MS must be an integer of at least 1000.",
    );
  }
  const mcpSessionIdleMs = Number(mcpSessionIdleMsValue);
  if (
    !Number.isSafeInteger(mcpSessionIdleMs) ||
    mcpSessionIdleMs < 1_000
  ) {
    throw new ConfigError(
      "READ_MY_CHATGPT_MCP_SESSION_IDLE_MS must be an integer of at least 1000.",
    );
  }

  const daemonIdleMsValue = (
    env.READ_MY_CHATGPT_DAEMON_IDLE_MS ?? "600000"
  ).trim();
  if (!/^\d+$/.test(daemonIdleMsValue)) {
    throw new ConfigError(
      "READ_MY_CHATGPT_DAEMON_IDLE_MS must be an integer of at least 100.",
    );
  }
  const daemonIdleMs = Number(daemonIdleMsValue);
  if (!Number.isSafeInteger(daemonIdleMs) || daemonIdleMs < 100) {
    throw new ConfigError(
      "READ_MY_CHATGPT_DAEMON_IDLE_MS must be an integer of at least 100.",
    );
  }

  const maxAssetBytesValue = (
    env.READ_MY_CHATGPT_MAX_ASSET_BYTES ?? "10485760"
  ).trim();
  if (!/^\d+$/.test(maxAssetBytesValue)) {
    throw new ConfigError(
      "READ_MY_CHATGPT_MAX_ASSET_BYTES must be an integer from 1 to 33554432.",
    );
  }
  const maxAssetBytes = Number(maxAssetBytesValue);
  if (
    !Number.isSafeInteger(maxAssetBytes) ||
    maxAssetBytes < 1 ||
    maxAssetBytes > 32 * 1024 * 1024
  ) {
    throw new ConfigError(
      "READ_MY_CHATGPT_MAX_ASSET_BYTES must be an integer from 1 to 33554432.",
    );
  }

  const obscuraCdpUrl = optionalValue(
    "READ_MY_CHATGPT_OBSCURA_CDP_URL",
  );
  if (obscuraCdpUrl) {
    let endpoint: URL;
    try {
      endpoint = new URL(obscuraCdpUrl);
    } catch {
      throw new ConfigError(
        "READ_MY_CHATGPT_OBSCURA_CDP_URL must be a valid URL.",
      );
    }
    const supportedProtocol = ["http:", "https:", "ws:", "wss:"].includes(
      endpoint.protocol,
    );
    const loopbackHost = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
      endpoint.hostname.toLowerCase(),
    );
    if (!supportedProtocol || !loopbackHost) {
      throw new ConfigError(
        "READ_MY_CHATGPT_OBSCURA_CDP_URL must use a loopback HTTP(S) or WebSocket endpoint.",
      );
    }
  }

  return {
    accessToken,
    baseUrl,
    outputTimezone,
    transport: transportValue,
    mcpTransport,
    mcpHost,
    mcpPort,
    mcpBearerToken: optionalValue(
      "READ_MY_CHATGPT_MCP_BEARER_TOKEN",
    ),
    mcpSessionIdleMs,
    daemonIdleMs,
    obscuraBinary: optionalValue("READ_MY_CHATGPT_OBSCURA_BIN"),
    obscuraCdpUrl,
    obscuraStorageDir: optionalValue(
      "READ_MY_CHATGPT_OBSCURA_STORAGE_DIR",
    ),
    obscuraTimezone: optionalValue("READ_MY_CHATGPT_OBSCURA_TIMEZONE"),
    defaultPageSize: 28,
    maxPageSize: 50,
    defaultMaxMessages: 100,
    // Title-only search scans this many list items max (paginated under the hood).
    searchMaxScan: 200,
    maxAssetBytes,
  };
}
