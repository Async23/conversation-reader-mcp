import {
  access,
  chmod,
  copyFile,
  mkdir,
  lstat,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { MCP_SERVER_NAME } from "./install-paths.js";

export const CLIENT_NAMES = [
  "codex",
  "claude",
  "cursor",
  "gemini",
  "grok",
  "opencode",
  "pi",
] as const;

export type ClientName = (typeof CLIENT_NAMES)[number];

export type ClientConfigurationResult = {
  client: ClientName;
  path: string;
  configured: boolean;
  backupPath?: string;
  reason?: string;
};

export type ClientLauncher = {
  command: string;
  args: readonly string[];
};

type ClientConnection =
  | {
      kind: "http";
      endpoint: string;
      bearerToken: string;
    }
  | {
      kind: "stdio";
      launcher: ClientLauncher;
    };

type ClientSpec = {
  name: ClientName;
  path: string;
  detectDirectory?: string;
  format: "json" | "codex-toml" | "grok-toml";
  rootKey?: "mcpServers" | "mcp";
};

const LEGACY_SERVER_NAMES = [
  "conversation-reader",
  "conversation-reader-mcp",
] as const;

export function clientSpecs(
  homeDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): readonly ClientSpec[] {
  const configHome =
    env.XDG_CONFIG_HOME?.trim() || join(homeDirectory, ".config");
  const codexDirectory =
    env.CODEX_HOME?.trim() || join(homeDirectory, ".codex");
  const piDirectory =
    env.PI_CODING_AGENT_DIR?.trim() ||
    join(homeDirectory, ".pi", "agent");
  return [
    {
      name: "codex",
      path: join(codexDirectory, "config.toml"),
      detectDirectory: codexDirectory,
      format: "codex-toml",
    },
    {
      name: "claude",
      path: join(homeDirectory, ".claude.json"),
      format: "json",
      rootKey: "mcpServers",
    },
    {
      name: "cursor",
      path: join(homeDirectory, ".cursor", "mcp.json"),
      detectDirectory: join(homeDirectory, ".cursor"),
      format: "json",
      rootKey: "mcpServers",
    },
    {
      name: "gemini",
      path: join(homeDirectory, ".gemini", "settings.json"),
      detectDirectory: join(homeDirectory, ".gemini"),
      format: "json",
      rootKey: "mcpServers",
    },
    {
      name: "grok",
      path: join(homeDirectory, ".grok", "config.toml"),
      detectDirectory: join(homeDirectory, ".grok"),
      format: "grok-toml",
    },
    {
      name: "opencode",
      path: join(configHome, "opencode", "opencode.json"),
      detectDirectory: join(configHome, "opencode"),
      format: "json",
      rootKey: "mcp",
    },
    {
      name: "pi",
      path: join(piDirectory, "mcp.json"),
      detectDirectory: join(
        piDirectory,
        "npm",
        "node_modules",
        "pi-mcp-adapter",
      ),
      format: "json",
      rootKey: "mcpServers",
    },
  ];
}

export async function configureClients(
  options: {
    homeDirectory: string;
    clients: readonly ClientName[] | "auto" | "all";
    env?: NodeJS.ProcessEnv;
  } & (
    | {
        endpoint: string;
        bearerToken: string;
        launcher?: never;
      }
    | {
        launcher: ClientLauncher;
        endpoint?: never;
        bearerToken?: never;
      }
  ),
): Promise<ClientConfigurationResult[]> {
  const specs = clientSpecs(options.homeDirectory, options.env);
  const connection: ClientConnection =
    options.launcher === undefined
      ? {
          kind: "http",
          endpoint: options.endpoint,
          bearerToken: options.bearerToken,
        }
      : {
          kind: "stdio",
          launcher: options.launcher,
        };
  const selected =
    options.clients === "all"
      ? specs
      : options.clients === "auto"
        ? await detectedSpecs(specs)
        : specs.filter((spec) => options.clients.includes(spec.name));

  const results: ClientConfigurationResult[] = [];
  for (const spec of selected) {
    try {
      const backupPath = await configureClient(
        spec,
        connection,
      );
      results.push({
        client: spec.name,
        path: spec.path,
        configured: true,
        backupPath,
      });
    } catch (error) {
      results.push({
        client: spec.name,
        path: spec.path,
        configured: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

export async function removeClientConfigurations(options: {
  homeDirectory: string;
  clients?: readonly ClientName[] | "all";
  env?: NodeJS.ProcessEnv;
}): Promise<ClientConfigurationResult[]> {
  const specs = clientSpecs(options.homeDirectory, options.env);
  const selected =
    options.clients === "all"
      ? specs
      : Array.isArray(options.clients)
        ? specs.filter((spec) => options.clients?.includes(spec.name))
        : specs;
  const results: ClientConfigurationResult[] = [];

  for (const spec of selected) {
    try {
      const targetPath = await resolveConfigPath(spec.path);
      const existing = await readOptional(targetPath);
      if (existing === undefined) continue;
      const contents =
        spec.format === "json"
          ? removeJsonServer(spec, existing)
          : removeAllTomlServers(existing);
      if (contents === existing) continue;
      const backupPath = await backupFile(targetPath);
      await atomicWrite(targetPath, contents, 0o600);
      results.push({
        client: spec.name,
        path: spec.path,
        configured: true,
        backupPath,
      });
    } catch (error) {
      results.push({
        client: spec.name,
        path: spec.path,
        configured: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

async function detectedSpecs(
  specs: readonly ClientSpec[],
): Promise<ClientSpec[]> {
  const detected: ClientSpec[] = [];
  for (const spec of specs) {
    if (
      (await fileExists(spec.path)) ||
      (spec.detectDirectory !== undefined &&
        (await directoryExists(spec.detectDirectory)))
    ) {
      detected.push(spec);
    }
  }
  return detected;
}

async function configureClient(
  spec: ClientSpec,
  connection: ClientConnection,
): Promise<string | undefined> {
  const targetPath = await resolveConfigPath(spec.path);
  const existing = await readOptional(targetPath);
  const backupPath =
    existing === undefined ? undefined : await backupFile(targetPath);
  const mode = 0o600;

  let contents: string;
  if (spec.format === "json") {
    contents = updateJsonConfig(
      spec,
      existing ?? "{}\n",
      connection,
    );
  } else {
    contents = updateTomlConfig(
      existing ?? "",
      spec.format,
      connection,
    );
  }

  await atomicWrite(targetPath, contents, mode);
  return backupPath;
}

function updateJsonConfig(
  spec: ClientSpec,
  existing: string,
  connection: ClientConnection,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch (error) {
    throw new Error(
      `Refusing to modify invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error("Refusing to modify a config whose root is not an object");
  }

  const rootKey = spec.rootKey!;
  const currentRoot = parsed[rootKey];
  if (currentRoot !== undefined && !isRecord(currentRoot)) {
    throw new Error(`Refusing to replace non-object ${rootKey}`);
  }
  const servers = currentRoot ?? {};
  for (const legacyName of LEGACY_SERVER_NAMES) {
    delete servers[legacyName];
  }
  servers[MCP_SERVER_NAME] = jsonServerValue(
    spec.name,
    connection,
  );
  parsed[rootKey] = servers;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function removeJsonServer(spec: ClientSpec, existing: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch (error) {
    throw new Error(
      `Refusing to modify invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error("Refusing to modify a config whose root is not an object");
  }
  const rootKey = spec.rootKey!;
  const currentRoot = parsed[rootKey];
  if (currentRoot === undefined) return existing;
  if (!isRecord(currentRoot)) {
    throw new Error(`Refusing to replace non-object ${rootKey}`);
  }

  let changed = false;
  for (const name of [MCP_SERVER_NAME, ...LEGACY_SERVER_NAMES]) {
    if (Object.hasOwn(currentRoot, name)) {
      delete currentRoot[name];
      changed = true;
    }
  }
  return changed ? `${JSON.stringify(parsed, null, 2)}\n` : existing;
}

function jsonServerValue(
  client: ClientName,
  connection: ClientConnection,
): Record<string, unknown> {
  if (connection.kind === "stdio") {
    const launcher = {
      command: connection.launcher.command,
      args: [...connection.launcher.args],
    };
    if (client === "gemini") {
      return { ...launcher, timeout: 60_000 };
    }
    if (client === "opencode") {
      return {
        type: "local",
        command: [
          connection.launcher.command,
          ...connection.launcher.args,
        ],
        enabled: true,
        timeout: 60_000,
      };
    }
    if (client === "pi") {
      return { ...launcher, directTools: true };
    }
    return launcher;
  }

  const headers = {
    Authorization: `Bearer ${connection.bearerToken}`,
  };
  if (client === "claude") {
    return { type: "http", url: connection.endpoint, headers };
  }
  if (client === "gemini") {
    return {
      httpUrl: connection.endpoint,
      headers,
      timeout: 60_000,
    };
  }
  if (client === "opencode") {
    return {
      type: "remote",
      url: connection.endpoint,
      headers,
      enabled: true,
      timeout: 60_000,
      oauth: false,
    };
  }
  if (client === "pi") {
    return {
      url: connection.endpoint,
      headers,
      directTools: true,
    };
  }
  return { url: connection.endpoint, headers };
}

function updateTomlConfig(
  existing: string,
  format: "codex-toml" | "grok-toml",
  connection: ClientConnection,
): string {
  let result = existing;
  for (const name of [MCP_SERVER_NAME, ...LEGACY_SERVER_NAMES]) {
    result = removeTomlTables(result, name);
  }
  result = result.trimEnd();
  const prefix = result ? `${result}\n\n` : "";
  if (connection.kind === "stdio") {
    const command = tomlString(connection.launcher.command);
    const args = connection.launcher.args.map(tomlString).join(", ");
    return (
      `${prefix}[mcp_servers.${MCP_SERVER_NAME}]\n` +
      `command = ${command}\n` +
      `args = [${args}]\n` +
      (format === "grok-toml" ? "enabled = true\n" : "")
    );
  }

  const escapedEndpoint = tomlString(connection.endpoint);
  const escapedAuthorization = tomlString(
    `Bearer ${connection.bearerToken}`,
  );

  if (format === "codex-toml") {
    return (
      `${prefix}[mcp_servers.${MCP_SERVER_NAME}]\n` +
      `url = ${escapedEndpoint}\n` +
      `http_headers = { Authorization = ${escapedAuthorization} }\n`
    );
  }
  return (
    `${prefix}[mcp_servers.${MCP_SERVER_NAME}]\n` +
    `url = ${escapedEndpoint}\n` +
    "enabled = true\n\n" +
    `[mcp_servers.${MCP_SERVER_NAME}.headers]\n` +
    `Authorization = ${escapedAuthorization}\n`
  );
}

function removeAllTomlServers(existing: string): string {
  let result = existing;
  for (const name of [MCP_SERVER_NAME, ...LEGACY_SERVER_NAMES]) {
    result = removeTomlTables(result, name);
  }
  if (result === existing) return existing;
  return result.trimEnd() ? `${result.trimEnd()}\n` : "";
}

function removeTomlTables(contents: string, serverName: string): string {
  const escapedName = escapeRegex(serverName);
  const matchingHeader = new RegExp(
    String.raw`^\s*\[\[?\s*mcp_servers\.(?:"${escapedName}"|'${escapedName}'|${escapedName})(?:\.|\s*\])`,
  );
  const lines = contents.split(/\r?\n/);
  const output: string[] = [];
  let skipping = false;

  for (const line of lines) {
    const isHeader = /^\s*\[\[?/.test(line);
    if (isHeader) {
      skipping = matchingHeader.test(line);
    }
    if (!skipping) output.push(line);
  }
  return output.join("\n");
}

async function backupFile(path: string): Promise<string> {
  const preferredPath = `${path}.bak`;
  const backupPath = (await fileExists(preferredPath))
    ? `${preferredPath}.${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`
    : preferredPath;
  await copyFile(path, backupPath);
  await chmod(backupPath, 0o600);
  return backupPath;
}

async function atomicWrite(
  path: string,
  contents: string,
  mode: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, contents, { mode });
  await rename(temporaryPath, path);
  await chmod(path, mode);
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function resolveConfigPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    try {
      const pathStat = await lstat(path);
      if (pathStat.isSymbolicLink()) {
        throw new Error(`Refusing to replace dangling symlink: ${path}`);
      }
    } catch (lstatError) {
      if (!isNodeError(lstatError, "ENOENT")) throw lstatError;
    }
    return path;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
