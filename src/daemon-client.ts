import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import { SERVICE_NAME } from "./install-paths.js";
import { PACKAGE_VERSION } from "./version.js";

const DAEMON_START_TIMEOUT_MS = 30_000;
const START_LOCK_STALE_MS = 30_000;

type RemoteConnection = {
  client: Client;
  transport: StreamableHTTPClientTransport;
};

type DaemonStatus =
  | "healthy"
  | "stopping"
  | "unavailable"
  | "occupied";

export class OnDemandDaemonClient {
  private connection?: RemoteConnection;
  private connecting?: Promise<RemoteConnection>;

  constructor(
    private readonly config: Config,
    private readonly configPath: string,
  ) {}

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const connection = await this.ensureConnection();
        return (await connection.client.callTool({
          name,
          arguments: args,
        })) as CallToolResult;
      } catch (error) {
        lastError = error;
        await this.resetConnection();
      }
    }
    throw lastError;
  }

  async close(): Promise<void> {
    await this.resetConnection();
  }

  private async ensureConnection(): Promise<RemoteConnection> {
    if (
      this.connection &&
      (await daemonIsHealthy(this.config))
    ) {
      return this.connection;
    }
    if (this.connection) {
      await this.resetConnection();
    }
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = undefined;
      });
    }
    this.connection = await this.connecting;
    return this.connection;
  }

  private async connect(): Promise<RemoteConnection> {
    await ensureDaemon(this.config, this.configPath);
    const transport = new StreamableHTTPClientTransport(
      daemonMcpUrl(this.config),
      {
        requestInit: this.config.mcpBearerToken
          ? {
              headers: {
                Authorization: `Bearer ${this.config.mcpBearerToken}`,
              },
            }
          : undefined,
      },
    );
    const client = new Client({
      name: `${SERVICE_NAME}-connector`,
      version: PACKAGE_VERSION,
    });
    try {
      await client.connect(transport);
      return { client, transport };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  private async resetConnection(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    if (!connection) return;
    await connection.transport.terminateSession().catch(() => undefined);
    await connection.client.close().catch(() => undefined);
  }
}

async function ensureDaemon(
  config: Config,
  configPath: string,
): Promise<void> {
  if (await daemonIsHealthy(config)) return;

  const lockPath = `${configPath}.daemon-start.lock`;
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await daemonIsHealthy(config)) return;

    let ownsLock = false;
    try {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        ownsLock = true;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }

      if (ownsLock) {
        const existing = await waitForExistingDaemon(
          config,
          deadline - Date.now(),
        );
        if (existing === "healthy") return;
        if (existing === "occupied") {
          throw new Error(
            `Port ${config.mcpPort} is occupied by another local service`,
          );
        }
        const child = await launchDaemon(configPath);
        await waitForDaemon(
          config,
          deadline - Date.now(),
          child,
        );
        return;
      }

      if (await startLockIsStale(lockPath)) {
        await recoverStaleStartLock(lockPath);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      if (ownsLock) {
        await rm(lockPath, { recursive: true, force: true });
      }
    }
  }
  throw new Error(
    `Timed out starting the shared ${SERVICE_NAME} daemon`,
  );
}

async function waitForExistingDaemon(
  config: Config,
  timeoutMs: number,
): Promise<"healthy" | "unavailable" | "occupied"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await daemonStatus(config);
    if (status !== "stopping") return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for the shared ${SERVICE_NAME} daemon to stop`,
  );
}

async function recoverStaleStartLock(lockPath: string): Promise<void> {
  const recoveryLockPath = `${lockPath}.recovery`;
  let ownsRecoveryLock = false;
  try {
    try {
      await mkdir(recoveryLockPath, { mode: 0o700 });
      ownsRecoveryLock = true;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }

    if (ownsRecoveryLock && (await startLockIsStale(lockPath))) {
      await rm(lockPath, { recursive: true, force: true });
    }
  } finally {
    if (ownsRecoveryLock) {
      await rm(recoveryLockPath, { recursive: true, force: true });
    }
  }
}

async function startLockIsStale(lockPath: string): Promise<boolean> {
  try {
    const lockStat = await stat(lockPath);
    return Date.now() - lockStat.mtimeMs >= START_LOCK_STALE_MS;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function launchDaemon(configPath: string): Promise<ChildProcess> {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    throw new Error("Cannot locate the read-my-chatgpt entrypoint");
  }
  const child = spawn(
    process.execPath,
    [
      ...process.execArgv,
      entrypoint,
      "daemon",
      "--config",
      configPath,
    ],
    {
      cwd: process.cwd(),
      detached: true,
      env: process.env,
      stdio: "ignore",
    },
  );
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  return child;
}

async function waitForDaemon(
  config: Config,
  timeoutMs: number,
  child: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await daemonIsHealthy(config)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `The shared ${SERVICE_NAME} daemon exited before it became ready`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out starting the shared ${SERVICE_NAME} daemon`,
  );
}

async function daemonIsHealthy(config: Config): Promise<boolean> {
  return (await daemonStatus(config)) === "healthy";
}

async function daemonStatus(config: Config): Promise<DaemonStatus> {
  try {
    const response = await fetch(daemonHealthUrl(config), {
      signal: AbortSignal.timeout(250),
    });
    if (!response.ok) return "occupied";
    const body = (await response.json()) as {
      status?: unknown;
      server?: unknown;
    };
    if (body.server !== SERVICE_NAME) return "occupied";
    if (body.status === "ok") return "healthy";
    if (body.status === "stopping") return "stopping";
    return "occupied";
  } catch (error) {
    return daemonUnavailableError(error)
      ? "unavailable"
      : "occupied";
  }
}

function daemonMcpUrl(config: Config): URL {
  return new URL(
    `http://${formatHost(config.mcpHost)}:${config.mcpPort}/mcp`,
  );
}

function daemonHealthUrl(config: Config): URL {
  return new URL("/healthz", daemonMcpUrl(config));
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function daemonUnavailableError(error: unknown): boolean {
  return ["ECONNREFUSED", "ECONNRESET", "UND_ERR_SOCKET"].some(
    (code) => hasErrorCode(error, code),
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (
      current instanceof Error &&
      "code" in current &&
      current.code === code
    ) {
      return true;
    }
    if (
      typeof current !== "object" ||
      current === null ||
      !("cause" in current)
    ) {
      return false;
    }
    current = current.cause;
  }
  return false;
}
