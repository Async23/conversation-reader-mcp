import { homedir } from "node:os";
import { join } from "node:path";

export const SERVICE_NAME = "read-my-chatgpt";
export const MCP_SERVER_NAME = "read-my-chatgpt";
export const LAUNCHD_LABEL = "io.github.async23.read-my-chatgpt";
export const LEGACY_SERVICE_NAME = "conversation-reader-mcp";
export const LEGACY_LAUNCHD_LABEL =
  "io.github.async23.conversation-reader-mcp";

export type InstallPaths = {
  serviceName: string;
  launchdLabel: string;
  homeDirectory: string;
  configDirectory: string;
  dataDirectory: string;
  serviceConfigPath: string;
  obscuraStorageDirectory: string;
  launchAgentPath: string;
  systemdUnitPath: string;
  stdoutLogPath: string;
  stderrLogPath: string;
};

export function installPaths(options: {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
} = {}): InstallPaths {
  return pathsForIdentity(SERVICE_NAME, LAUNCHD_LABEL, options);
}

export function legacyInstallPaths(options: {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
} = {}): InstallPaths {
  return pathsForIdentity(
    LEGACY_SERVICE_NAME,
    LEGACY_LAUNCHD_LABEL,
    options,
  );
}

function pathsForIdentity(
  serviceName: string,
  launchdLabel: string,
  options: {
    env?: NodeJS.ProcessEnv;
    homeDirectory?: string;
  },
): InstallPaths {
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const configHome =
    env.XDG_CONFIG_HOME?.trim() || join(homeDirectory, ".config");
  const dataHome =
    env.XDG_DATA_HOME?.trim() ||
    join(homeDirectory, ".local", "share");
  const configDirectory = join(configHome, serviceName);
  const dataDirectory = join(dataHome, serviceName);

  return {
    serviceName,
    launchdLabel,
    homeDirectory,
    configDirectory,
    dataDirectory,
    serviceConfigPath: join(configDirectory, "service.json"),
    obscuraStorageDirectory: join(dataDirectory, "obscura-profile"),
    launchAgentPath: join(
      homeDirectory,
      "Library",
      "LaunchAgents",
      `${launchdLabel}.plist`,
    ),
    systemdUnitPath: join(
      configHome,
      "systemd",
      "user",
      `${serviceName}.service`,
    ),
    stdoutLogPath: join(
      homeDirectory,
      "Library",
      "Logs",
      `${serviceName}.log`,
    ),
    stderrLogPath: join(
      homeDirectory,
      "Library",
      "Logs",
      `${serviceName}.error.log`,
    ),
  };
}
