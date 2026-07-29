import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir, rm, stat, utimes } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ErrorCode,
  McpError,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { ConfigError, type Config } from "./config.js";
import { fetchVerifiedDaemonHealth } from "./daemon-health.js";
import { SERVICE_NAME } from "./install-paths.js";
import { PACKAGE_VERSION } from "./version.js";

const START_LOCK_STALE_MS = 30_000;
const START_LOCK_HEARTBEAT_MS = 5_000;
const DAEMON_TERMINATE_GRACE_MS = 2_000;
const REMOTE_TOOL_TIMEOUT_MS = 10 * 60_000;

type RemoteConnection = {
  client: Client;
  transport: StreamableHTTPClientTransport;
  closePromise?: Promise<void>;
};

type DaemonStatus =
  | "healthy"
  | "stopping"
  | "unavailable"
  | "occupied";

export class OnDemandDaemonClient {
  private connection?: RemoteConnection;
  private connecting?: Promise<RemoteConnection>;
  private readonly lifecycle = new AbortController();
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly config: Config,
    private readonly configPath: string,
  ) {}

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    this.throwIfClosedOrAborted(signal);
    let connection = await this.ensureConnection(signal);
    try {
      return (await connection.client.callTool(
        {
          name,
          arguments: args,
        },
        undefined,
        {
          signal: combinedSignal(signal, this.lifecycle.signal),
          timeout: REMOTE_TOOL_TIMEOUT_MS,
        },
      )) as CallToolResult;
    } catch (error) {
      if (
        !retryableDaemonCallError(error) ||
        this.closed ||
        signal?.aborted
      ) {
        throw error;
      }
      await this.resetConnection(connection);
      this.throwIfClosedOrAborted(signal);
      connection = await this.ensureConnection(signal);
      try {
        return (await connection.client.callTool(
          {
            name,
            arguments: args,
          },
          undefined,
          {
            signal: combinedSignal(signal, this.lifecycle.signal),
            timeout: REMOTE_TOOL_TIMEOUT_MS,
          },
        )) as CallToolResult;
      } catch (retryError) {
        if (
          retryableDaemonCallError(retryError) &&
          !this.closed &&
          !signal?.aborted
        ) {
          await this.resetConnection(connection);
        }
        throw retryError;
      }
    }
  }

  async close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      this.lifecycle.abort(
        new Error(`${SERVICE_NAME} connector is closed`),
      );
      const connection = this.connection;
      const connecting = this.connecting;
      this.connection = undefined;
      this.closePromise = Promise.resolve().then(async () => {
        const connectedWhileClosing = connecting
          ? await connecting.catch(() => undefined)
          : undefined;
        await Promise.allSettled([
          closeRemoteConnection(connection),
          closeRemoteConnection(connectedWhileClosing),
        ]);
      });
    }
    await this.closePromise;
  }

  private async ensureConnection(
    signal?: AbortSignal,
  ): Promise<RemoteConnection> {
    this.throwIfClosedOrAborted(signal);
    if (
      this.connection &&
      (await daemonIsHealthy(this.config))
    ) {
      return this.connection;
    }
    if (this.connection) {
      await this.resetConnection(this.connection);
    }
    this.throwIfClosedOrAborted(signal);
    if (!this.connecting) {
      const connecting = this.connect().then(async (connection) => {
        if (this.closed) {
          await closeRemoteConnection(connection);
          this.throwIfClosedOrAborted();
        }
        this.connection = connection;
        return connection;
      });
      this.connecting = connecting;
      const clearConnecting = () => {
        if (this.connecting === connecting) {
          this.connecting = undefined;
        }
      };
      void connecting.then(clearConnecting, clearConnecting);
    }
    return waitForPromise(this.connecting, signal);
  }

  private async connect(): Promise<RemoteConnection> {
    const bearerToken = this.config.mcpBearerToken;
    if (!bearerToken) {
      throw new ConfigError(
        "The on-demand daemon requires READ_MY_CHATGPT_MCP_BEARER_TOKEN.",
      );
    }
    await ensureDaemon(
      this.config,
      this.configPath,
      this.lifecycle.signal,
    );
    this.throwIfClosedOrAborted();
    const transport = new StreamableHTTPClientTransport(
      daemonMcpUrl(this.config),
      {
        requestInit: {
          headers: {
            Authorization: `Bearer ${bearerToken}`,
          },
        },
      },
    );
    const client = new Client({
      name: `${SERVICE_NAME}-connector`,
      version: PACKAGE_VERSION,
    });
    try {
      await client.connect(transport, {
        signal: this.lifecycle.signal,
      });
      return { client, transport };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  private async resetConnection(
    connection: RemoteConnection,
  ): Promise<void> {
    if (this.connection === connection) {
      this.connection = undefined;
    }
    await closeRemoteConnection(connection);
  }

  private throwIfClosedOrAborted(signal?: AbortSignal): void {
    if (this.closed) {
      throw (
        this.lifecycle.signal.reason ??
        new Error(`${SERVICE_NAME} connector is closed`)
      );
    }
    signal?.throwIfAborted();
  }
}

async function ensureDaemon(
  config: Config,
  configPath: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (await daemonIsHealthy(config)) return;

  const lockPath = `${configPath}.daemon-start.lock`;
  const deadline = Date.now() + config.daemonStartTimeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (await daemonIsHealthy(config)) return;

    let ownsLock = false;
    let stopLockHeartbeat: (() => void) | undefined;
    try {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        ownsLock = true;
        stopLockHeartbeat = startLockHeartbeat(lockPath);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }

      if (ownsLock) {
        const existing = await waitForExistingDaemon(
          config,
          deadline - Date.now(),
          signal,
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
          signal,
        );
        return;
      }

      if (await startLockIsStale(lockPath)) {
        await recoverStaleStartLock(lockPath);
        continue;
      }
      await sleep(50, undefined, { signal });
    } finally {
      if (ownsLock) {
        stopLockHeartbeat?.();
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
  signal: AbortSignal,
): Promise<"healthy" | "unavailable" | "occupied"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const status = await daemonStatus(config);
    if (status !== "stopping") return status;
    await sleep(50, undefined, { signal });
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
  return child;
}

async function waitForDaemon(
  config: Config,
  timeoutMs: number,
  child: ChildProcess,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let ready = false;
  try {
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (await daemonIsHealthy(config)) {
        ready = true;
        child.unref();
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `The shared ${SERVICE_NAME} daemon exited before it became ready`,
        );
      }
      await sleep(50, undefined, { signal });
    }
    throw new Error(
      `Timed out starting the shared ${SERVICE_NAME} daemon`,
    );
  } finally {
    if (!ready) {
      await terminateDetachedDaemon(child);
    }
  }
}

function startLockHeartbeat(lockPath: string): () => void {
  const timer = setInterval(() => {
    const now = new Date();
    void utimes(lockPath, now, now).catch((error) => {
      if (!isNotFound(error)) {
        clearInterval(timer);
      }
    });
  }, START_LOCK_HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

async function terminateDetachedDaemon(
  child: ChildProcess,
): Promise<void> {
  const processGroup = child.pid;
  if (process.platform !== "win32" && processGroup) {
    signalProcessGroup(processGroup, "SIGTERM");
    if (
      await waitForProcessGroupExit(
        processGroup,
        DAEMON_TERMINATE_GRACE_MS,
      )
    ) {
      return;
    }
    signalProcessGroup(processGroup, "SIGKILL");
    await waitForProcessGroupExit(
      processGroup,
      DAEMON_TERMINATE_GRACE_MS,
    );
    return;
  }

  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForChildExit(child, DAEMON_TERMINATE_GRACE_MS)) return;
  child.kill("SIGKILL");
  await waitForChildExit(child, DAEMON_TERMINATE_GRACE_MS);
}

function signalProcessGroup(
  processGroup: number,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-processGroup, signal);
  } catch (error) {
    if (!hasErrorCode(error, "ESRCH")) throw error;
  }
}

async function waitForProcessGroupExit(
  processGroup: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupIsAlive(processGroup)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processGroupIsAlive(processGroup);
}

function processGroupIsAlive(processGroup: number): boolean {
  try {
    process.kill(-processGroup, 0);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ESRCH")) return false;
    throw error;
  }
}

function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function daemonIsHealthy(config: Config): Promise<boolean> {
  return (await daemonStatus(config)) === "healthy";
}

async function daemonStatus(config: Config): Promise<DaemonStatus> {
  const bearerToken = config.mcpBearerToken;
  if (!bearerToken) return "occupied";
  try {
    const status = await fetchVerifiedDaemonHealth(
      daemonHealthUrl(config),
      bearerToken,
      250,
    );
    return status === "ok" ? "healthy" : "stopping";
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

function retryableDaemonCallError(error: unknown): boolean {
  if (error instanceof McpError) {
    return error.code === ErrorCode.ConnectionClosed;
  }
  if (error instanceof StreamableHTTPError) {
    return [404, 502, 503, 504].includes(error.code ?? 0);
  }
  return daemonUnavailableError(error);
}

function combinedSignal(
  signal: AbortSignal | undefined,
  lifecycleSignal: AbortSignal,
): AbortSignal {
  return signal
    ? AbortSignal.any([signal, lifecycleSignal])
    : lifecycleSignal;
}

function waitForPromise<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function closeRemoteConnection(
  connection: RemoteConnection | undefined,
): Promise<void> {
  if (!connection) return;
  if (!connection.closePromise) {
    connection.closePromise = Promise.resolve().then(async () => {
      await connection.transport
        .terminateSession()
        .catch(() => undefined);
      await connection.client.close().catch(() => undefined);
    });
  }
  await connection.closePromise;
}
