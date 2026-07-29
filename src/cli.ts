import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  CLIENT_NAMES,
  configureClients,
  removeClientConfigurations,
  type ClientName,
} from "./client-config.js";
import { startConnectorMcpServer } from "./connector.js";
import { ConfigError, loadConfig } from "./config.js";
import { startHttpMcpServer } from "./http-server.js";
import { migrateLegacyInstallation } from "./install-migration.js";
import {
  installPaths,
  legacyInstallPaths,
  SERVICE_NAME,
} from "./install-paths.js";
import {
  ensureObscuraBinary,
  validateObscuraBinary,
} from "./obscura-installer.js";
import { ReadMyChatGptRuntime } from "./runtime.js";
import {
  applyServiceEnvironment,
  readServiceEnvironment,
  writeServiceEnvironment,
  type ServiceEnvironment,
} from "./service-config.js";
import {
  getServiceStatus,
  uninstallService,
} from "./service-manager.js";
import {
  type RunningMcpServer,
  startStdioMcpServer,
} from "./stdio-server.js";
import { PACKAGE_VERSION } from "./version.js";

export const CLI_VERSION = PACKAGE_VERSION;
const DEFAULT_PORT = 47_831;
const PRODUCT = SERVICE_NAME;

type InitOptions = {
  port: number;
  configure: boolean;
  yes: boolean;
};

type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export async function runCli(args: readonly string[]): Promise<void> {
  const command = args[0];
  if (!command) {
    await runMcpService();
    return;
  }

  if (command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(CLI_VERSION);
    return;
  }
  if (command === "serve") {
    const configPath = optionValue(args.slice(1), "--config");
    assertOnlyOptions(args.slice(1), ["--config"]);
    await runMcpService(configPath);
    return;
  }
  if (command === "daemon") {
    const configPath = optionValue(args.slice(1), "--config");
    assertOnlyOptions(args.slice(1), ["--config"]);
    await runMcpDaemon(configPath);
    return;
  }
  if (command === "connect") {
    const configPath = optionValue(args.slice(1), "--config");
    assertOnlyOptions(args.slice(1), ["--config"]);
    await runConnector(configPath);
    return;
  }
  if (command === "init" || command === "setup") {
    const options = parseInitOptions(args.slice(1));
    if (command === "setup") {
      console.error(
        `[${PRODUCT}] "setup" is deprecated; use "${PRODUCT} init".`,
      );
    }
    await init(options);
    return;
  }
  if (command === "configure") {
    await configure(args.slice(1));
    return;
  }
  if (command === "doctor") {
    const json = args.slice(1).includes("--json");
    assertOnlyOptions(args.slice(1), ["--json"]);
    const healthy = await doctor(json);
    if (!healthy) process.exitCode = 1;
    return;
  }
  if (command === "uninstall") {
    const purge = args.slice(1).includes("--purge");
    const yes = args.slice(1).includes("--yes");
    assertOnlyOptions(args.slice(1), ["--purge", "--yes"]);
    await uninstall(purge, yes);
    return;
  }

  throw new Error(`Unknown command: ${command}. Run ${PRODUCT} --help.`);
}

export async function runMcpService(configPath?: string): Promise<void> {
  if (configPath) {
    applyServiceEnvironment(await readServiceEnvironment(configPath));
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(
      error instanceof Error ? error.message : String(error),
    );
  }

  const runtime = await ReadMyChatGptRuntime.create(config);
  let running: RunningMcpServer;
  if (config.mcpTransport === "http") {
    running = await startHttpMcpServer(runtime, {
      host: config.mcpHost,
      port: config.mcpPort,
      bearerToken: config.mcpBearerToken,
      sessionIdleMs: config.mcpSessionIdleMs,
    });
    console.error(
      `[${PRODUCT}] ready on http://${formatHost(config.mcpHost)}:${config.mcpPort}/mcp`,
    );
  } else {
    running = await startStdioMcpServer(runtime);
    console.error(`[${PRODUCT}] ready on stdio`);
  }

  let shuttingDown = false;
  const shutdown = async (exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await running.close();
    process.exit(exitCode);
  };
  process.once("SIGINT", () => void shutdown(130));
  process.once("SIGTERM", () => void shutdown(143));
}

async function runConnector(configPath?: string): Promise<void> {
  const resolvedConfigPath =
    configPath ?? installPaths().serviceConfigPath;
  applyServiceEnvironment(
    await readServiceEnvironment(resolvedConfigPath),
  );

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(
      error instanceof Error ? error.message : String(error),
    );
  }

  const running = await startConnectorMcpServer(
    config,
    resolvedConfigPath,
  );
  let shuttingDown = false;
  const shutdown = async (exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await running.close();
    process.exit(exitCode);
  };
  process.once("SIGINT", () => void shutdown(130));
  process.once("SIGTERM", () => void shutdown(143));
}

async function runMcpDaemon(configPath?: string): Promise<void> {
  const resolvedConfigPath =
    configPath ?? installPaths().serviceConfigPath;
  applyServiceEnvironment(
    await readServiceEnvironment(resolvedConfigPath),
  );

  const config = loadConfig();
  if (config.mcpTransport !== "http") {
    throw new ConfigError(
      "The on-demand daemon requires READ_MY_CHATGPT_MCP_TRANSPORT=http.",
    );
  }

  const runtime = await ReadMyChatGptRuntime.create(config);
  const running = await startHttpMcpServer(runtime, {
    host: config.mcpHost,
    port: config.mcpPort,
    bearerToken: config.mcpBearerToken,
    sessionIdleMs: config.mcpSessionIdleMs,
    toolIdleMs: config.daemonIdleMs,
  });

  let shuttingDown = false;
  const shutdown = async (exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await running.close();
    process.exit(exitCode);
  };
  process.once("SIGINT", () => void shutdown(130));
  process.once("SIGTERM", () => void shutdown(143));

  await running.idle;
  await shutdown(0);
}

async function init(options: InitOptions): Promise<void> {
  assertServicePlatform(process.platform);
  if (!options.yes) {
    console.error(
      "This tool uses non-public ChatGPT Web endpoints. Automated extraction may be restricted by the service terms.",
    );
    const answer = await promptVisible(
      "Continue only if you have confirmed your use is permitted. Continue? [y/N] ",
    );
    if (!/^y(?:es)?$/i.test(answer.trim())) {
      throw new Error("Initialization cancelled.");
    }
  }
  const paths = installPaths();
  await stopOnDemandDaemon(
    await readOptionalServiceEnvironment(
      paths.serviceConfigPath,
    ),
  );
  await uninstallService({
    platform: process.platform,
    paths,
  });
  const migration = await migrateLegacyInstallation({
    platform: process.platform,
  });
  if (migration.detected) {
    console.error(
      `[${PRODUCT}] Migrated the previous conversation-reader-mcp installation.`,
    );
    if (migration.retainedPaths.length > 0) {
      console.error(
        `[${PRODUCT}] Kept ${migration.retainedPaths.length} legacy path(s) because new data already existed.`,
      );
    }
  }
  const existing = await readOptionalServiceEnvironment(
    paths.serviceConfigPath,
  );
  const accessToken = normalizeAccessToken(
    process.env.READ_MY_CHATGPT_ACCESS_TOKEN ||
      existing?.READ_MY_CHATGPT_ACCESS_TOKEN ||
      (await promptHidden("ChatGPT Web access token: ")),
  );
  if (!accessToken) {
    throw new Error("Access token cannot be empty.");
  }

  const bearerToken =
    process.env.READ_MY_CHATGPT_MCP_BEARER_TOKEN?.trim() ||
    existing?.READ_MY_CHATGPT_MCP_BEARER_TOKEN ||
    randomBytes(32).toString("base64url");

  const obscuraBinary = await ensureObscuraBinary({
    explicitBinary:
      process.env.READ_MY_CHATGPT_OBSCURA_BIN ||
      existing?.READ_MY_CHATGPT_OBSCURA_BIN,
    log: (message) => console.error(`[${PRODUCT}] ${message}`),
  });

  await mkdir(paths.dataDirectory, { recursive: true, mode: 0o700 });
  await mkdir(paths.obscuraStorageDirectory, {
    recursive: true,
    mode: 0o700,
  });
  await chmod(paths.dataDirectory, 0o700);
  await chmod(paths.obscuraStorageDirectory, 0o700);
  const environment: ServiceEnvironment = {
    READ_MY_CHATGPT_ACCESS_TOKEN: accessToken,
    READ_MY_CHATGPT_TRANSPORT: "obscura",
    READ_MY_CHATGPT_OBSCURA_BIN: obscuraBinary,
    READ_MY_CHATGPT_OBSCURA_STORAGE_DIR:
      paths.obscuraStorageDirectory,
    READ_MY_CHATGPT_MCP_TRANSPORT: "http",
    READ_MY_CHATGPT_MCP_HOST: "127.0.0.1",
    READ_MY_CHATGPT_MCP_PORT: String(options.port),
    READ_MY_CHATGPT_MCP_BEARER_TOKEN: bearerToken,
    READ_MY_CHATGPT_DAEMON_IDLE_MS:
      process.env.READ_MY_CHATGPT_DAEMON_IDLE_MS?.trim() ||
      existing?.READ_MY_CHATGPT_DAEMON_IDLE_MS ||
      "600000",
  };
  const maxAssetBytes =
    process.env.READ_MY_CHATGPT_MAX_ASSET_BYTES?.trim() ||
    existing?.READ_MY_CHATGPT_MAX_ASSET_BYTES;
  if (maxAssetBytes) {
    environment.READ_MY_CHATGPT_MAX_ASSET_BYTES = maxAssetBytes;
  }
  const outputTimezone =
    process.env.READ_MY_CHATGPT_OUTPUT_TIMEZONE?.trim() ||
    existing?.READ_MY_CHATGPT_OUTPUT_TIMEZONE;
  if (outputTimezone) {
    environment.READ_MY_CHATGPT_OUTPUT_TIMEZONE = outputTimezone;
  }
  const initializedConfig = loadConfig(environment);
  await writeServiceEnvironment(paths.serviceConfigPath, environment);

  let configured = 0;
  if (options.configure) {
    const results = await configureClients({
      homeDirectory: homedir(),
      launcher: connectorLauncher(),
      clients: "auto",
    });
    for (const result of results) {
      if (result.configured) {
        configured += 1;
        console.log(`✓ ${result.client}: ${result.path}`);
      } else {
        console.error(
          `! ${result.client}: ${result.reason ?? "configuration failed"}`,
        );
      }
    }
  }

  console.log(`\n${PRODUCT} is initialized.`);
  console.log(
    configured > 0
      ? `Configured ${configured} detected AI client(s). Restart them once.`
      : `No existing client config was detected. Run: ${npxCommand("configure all")}`,
  );
  console.log(
    `The shared daemon starts on the first tool call and stops after ${formatIdleDuration(initializedConfig.daemonIdleMs)} without a tool call.`,
  );
  console.log(`Check anytime with: ${npxCommand("doctor")}`);
}

async function configure(args: readonly string[]): Promise<void> {
  const paths = installPaths();
  const environment = await readOptionalServiceEnvironment(
    paths.serviceConfigPath,
  );
  if (!environment) {
    throw new Error(
      `Service config not found. Run ${npxCommand("init")} first.`,
    );
  }

  let selection: readonly ClientName[] | "auto" | "all";
  if (args.length === 0 || (args.length === 1 && args[0] === "auto")) {
    selection = "auto";
  } else if (args.length === 1 && args[0] === "all") {
    selection = "all";
  } else {
    const invalid = args.filter(
      (name) => !CLIENT_NAMES.includes(name as ClientName),
    );
    if (invalid.length > 0) {
      throw new Error(
        `Unknown client(s): ${invalid.join(", ")}. Supported: ${CLIENT_NAMES.join(", ")}`,
      );
    }
    selection = args as ClientName[];
  }

  const results = await configureClients({
    homeDirectory: homedir(),
    launcher: connectorLauncher(),
    clients: selection,
  });
  if (results.length === 0) {
    console.log(
      `No existing client config detected. Use "${npxCommand("configure all")}" or name clients explicitly.`,
    );
    return;
  }

  let failures = 0;
  for (const result of results) {
    if (result.configured) {
      console.log(`✓ ${result.client}: ${result.path}`);
    } else {
      failures += 1;
      console.error(`✗ ${result.client}: ${result.reason}`);
    }
  }
  if (failures > 0) {
    throw new Error(`${failures} client configuration(s) failed.`);
  }
  console.log("Restart the configured AI clients once.");
}

async function doctor(json: boolean): Promise<boolean> {
  const paths = installPaths();
  const checks: DoctorCheck[] = [];
  checks.push({
    name: "platform",
    ok: process.platform === "darwin" || process.platform === "linux",
    detail: `${process.platform}/${process.arch}`,
  });
  checks.push({
    name: "node",
    ok: Number(process.versions.node.split(".")[0]) >= 22,
    detail: `Node ${process.versions.node}`,
  });

  let environment: ServiceEnvironment | undefined;
  try {
    environment = await readServiceEnvironment(paths.serviceConfigPath);
    const configStat = await stat(paths.serviceConfigPath);
    checks.push({
      name: "service-config",
      ok: (configStat.mode & 0o077) === 0,
      detail:
        (configStat.mode & 0o077) === 0
          ? "present, permissions are private"
          : "present, but permissions are too broad",
    });
  } catch (error) {
    checks.push({
      name: "service-config",
      ok: false,
      detail: errorMessage(error),
    });
  }

  try {
    const serviceStatus = await getServiceStatus({
      platform: process.platform,
      paths,
    });
    const absent =
      !serviceStatus.installed && !serviceStatus.running;
    checks.push({
      name: "persistent-service",
      ok: absent,
      detail: absent
        ? "not installed (on-demand mode)"
        : `${serviceStatus.manager}: ${
            serviceStatus.installed ? "installed" : "not installed"
          }, ${serviceStatus.running ? "running" : "not running"}`,
    });
  } catch (error) {
    checks.push({
      name: "persistent-service",
      ok: false,
      detail: errorMessage(error),
    });
  }

  if (environment?.READ_MY_CHATGPT_OBSCURA_BIN) {
    try {
      await validateObscuraBinary(
        environment.READ_MY_CHATGPT_OBSCURA_BIN,
      );
      checks.push({
        name: "obscura",
        ok: true,
        detail: "compatible executable",
      });
    } catch (error) {
      checks.push({
        name: "obscura",
        ok: false,
        detail: errorMessage(error),
      });
    }
  } else {
    checks.push({
      name: "obscura",
      ok: false,
      detail: "not configured",
    });
  }

  if (environment) {
    const endpoint = endpointFor(environment);
    try {
      await fetchHealth(endpoint);
      checks.push({
        name: "on-demand-daemon",
        ok: true,
        detail: `running at ${endpoint}`,
      });
    } catch (error) {
      checks.push({
        name: "on-demand-daemon",
        ok: hasNodeErrorCode(error, "ECONNREFUSED"),
        detail: hasNodeErrorCode(error, "ECONNREFUSED")
          ? "stopped (starts on first tool call)"
          : `${endpoint}: ${errorMessage(error)}`,
      });
    }
  }

  const healthy = checks.every((check) => check.ok);
  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: healthy,
          checks,
          paths: {
            config: paths.serviceConfigPath,
            data: paths.dataDirectory,
          },
        },
        null,
        2,
      ),
    );
  } else {
    for (const check of checks) {
      console.log(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`);
    }
    console.log(healthy ? "\nAll checks passed." : "\nSome checks failed.");
  }
  return healthy;
}

async function uninstall(purge: boolean, yes: boolean): Promise<void> {
  const paths = installPaths();
  const legacyPaths = legacyInstallPaths();
  await stopOnDemandDaemon(
    await readOptionalServiceEnvironment(
      paths.serviceConfigPath,
    ),
  );
  await uninstallService({
    platform: process.platform,
    paths,
  });
  await uninstallService({
    platform: process.platform,
    paths: legacyPaths,
  });
  console.log("Persistent service (if any) removed.");
  const clientResults = await removeClientConfigurations({
    homeDirectory: homedir(),
  });
  for (const result of clientResults) {
    if (result.configured) {
      console.log(`✓ removed from ${result.client}: ${result.path}`);
    } else {
      console.error(`! ${result.client}: ${result.reason}`);
    }
  }

  if (!purge) {
    console.log(
      `Configuration and local data were kept. Remove them with: ${npxCommand("uninstall --purge")}`,
    );
    return;
  }
  if (!yes) {
    const answer = await promptVisible(
      "Delete the stored token, Obscura profile, and downloaded binary? [y/N] ",
    );
    if (!/^y(?:es)?$/i.test(answer.trim())) {
      console.log("Local data kept.");
      return;
    }
  }
  await rm(paths.configDirectory, { recursive: true, force: true });
  await rm(paths.dataDirectory, { recursive: true, force: true });
  await rm(paths.stdoutLogPath, { force: true });
  await rm(paths.stderrLogPath, { force: true });
  await rm(legacyPaths.configDirectory, {
    recursive: true,
    force: true,
  });
  await rm(legacyPaths.dataDirectory, {
    recursive: true,
    force: true,
  });
  await rm(legacyPaths.stdoutLogPath, { force: true });
  await rm(legacyPaths.stderrLogPath, { force: true });
  console.log("Local configuration and data removed.");
}

function parseInitOptions(args: readonly string[]): InitOptions {
  assertOnlyOptions(args, ["--port", "--no-configure", "--yes"]);
  const value = optionValue(args, "--port");
  const port = value === undefined ? DEFAULT_PORT : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--port must be an integer from 1 to 65535.");
  }
  return {
    port,
    configure: !args.includes("--no-configure"),
    yes: args.includes("--yes"),
  };
}

function assertOnlyOptions(
  args: readonly string[],
  supported: readonly string[],
): void {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!supported.includes(argument)) {
      throw new Error(`Unknown option: ${argument}`);
    }
    if (argument === "--config" || argument === "--port") {
      if (!args[index + 1] || args[index + 1].startsWith("-")) {
        throw new Error(`${argument} requires a value.`);
      }
      index += 1;
    }
  }
}

function optionValue(
  args: readonly string[],
  option: string,
): string | undefined {
  const index = args.indexOf(option);
  return index < 0 ? undefined : args[index + 1];
}

function endpointFor(environment: ServiceEnvironment): string {
  const host = environment.READ_MY_CHATGPT_MCP_HOST || "127.0.0.1";
  const port = environment.READ_MY_CHATGPT_MCP_PORT || String(DEFAULT_PORT);
  return `http://${formatHost(host)}:${port}/mcp`;
}

async function stopOnDemandDaemon(
  environment: ServiceEnvironment | undefined,
): Promise<void> {
  if (
    !environment ||
    environment.READ_MY_CHATGPT_MCP_TRANSPORT !== "http"
  ) {
    return;
  }

  const endpoint = endpointFor(environment);
  const shutdownUrl = new URL("/shutdown", endpoint);
  const bearerToken =
    environment.READ_MY_CHATGPT_MCP_BEARER_TOKEN?.trim();
  let response: Response;
  try {
    response = await fetch(shutdownUrl, {
      method: "POST",
      headers: bearerToken
        ? { Authorization: `Bearer ${bearerToken}` }
        : undefined,
      signal: AbortSignal.timeout(2_000),
    });
  } catch (error) {
    if (hasNodeErrorCode(error, "ECONNREFUSED")) return;
    throw error;
  }

  // Persistent pre-on-demand versions do not expose this endpoint.
  // Their launchd/systemd service is stopped immediately afterwards.
  if (response.status === 404) return;
  if (!response.ok) {
    throw new Error(
      `Could not stop the on-demand daemon: HTTP ${response.status}`,
    );
  }

  const healthUrl = new URL("/healthz", endpoint);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await fetch(healthUrl, {
        signal: AbortSignal.timeout(500),
      });
    } catch (error) {
      if (
        hasNodeErrorCode(error, "ECONNREFUSED") ||
        hasNodeErrorCode(error, "ECONNRESET") ||
        hasNodeErrorCode(error, "UND_ERR_SOCKET")
      ) {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out stopping the on-demand daemon.");
}

async function fetchHealth(endpoint: string): Promise<void> {
  const healthUrl = new URL("/healthz", endpoint);
  const response = await fetch(healthUrl, {
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    status?: unknown;
    server?: unknown;
  };
  if (body.status !== "ok" || body.server !== PRODUCT) {
    throw new Error("unexpected health response");
  }
}

async function readOptionalServiceEnvironment(
  path: string,
): Promise<ServiceEnvironment | undefined> {
  try {
    return await readServiceEnvironment(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function assertServicePlatform(platform: NodeJS.Platform): void {
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(
      `On-demand initialization supports macOS and Linux; got ${platform}.`,
    );
  }
}

async function promptHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error(
      "Set READ_MY_CHATGPT_ACCESS_TOKEN when running init non-interactively.",
    );
  }
  process.stderr.write(prompt);
  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          cleanup();
          process.stderr.write("\n");
          resolve(value.trim());
          return;
        }
        if (character === "\u0003") {
          cleanup();
          process.stderr.write("\n");
          reject(new Error("Initialization cancelled."));
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function promptVisible(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return "";
  process.stderr.write(prompt);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  return new Promise((resolve) => {
    process.stdin.once("data", (chunk: string) => {
      process.stdin.pause();
      resolve(chunk);
    });
  });
}

function printHelp(): void {
  console.log(`${PRODUCT} ${CLI_VERSION}

Read your own web conversation history through one on-demand MCP runtime.

Usage:
  ${PRODUCT} init [--port 47831] [--no-configure] [--yes]
  ${PRODUCT} configure [auto|all|${CLIENT_NAMES.join("|")} ...]
  ${PRODUCT} doctor [--json]
  ${PRODUCT} uninstall [--purge] [--yes]
  ${PRODUCT} connect [--config PATH]
  ${PRODUCT} serve [--config PATH]
  ${PRODUCT} --version

Running without a command starts a stdio MCP for legacy clients.

Secrets:
  init prompts without echo. For automation, set
  READ_MY_CHATGPT_ACCESS_TOKEN in the environment.`);
}

function connectorLauncher(): {
  command: string;
  args: readonly string[];
} {
  return {
    command: "npx",
    args: ["-y", `${PRODUCT}@${PACKAGE_VERSION}`, "connect"],
  };
}

function npxCommand(args: string): string {
  return `npx -y ${PRODUCT}@${PACKAGE_VERSION} ${args}`;
}

function formatIdleDuration(milliseconds: number): string {
  if (milliseconds % 60_000 === 0) {
    const minutes = milliseconds / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (milliseconds % 1_000 === 0) {
    const seconds = milliseconds / 1_000;
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  return `${milliseconds} ms`;
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function normalizeAccessToken(value: string): string {
  return value.trim().replace(/^Bearer\s+/i, "").trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
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
