import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import type { InstallPaths } from "./install-paths.js";

export type ServiceManagerOptions = {
  platform: NodeJS.Platform;
  paths: InstallPaths;
  uid?: number;
};

export type ServiceStatus = {
  manager: "launchd" | "systemd";
  installed: boolean;
  running: boolean;
  detail?: string;
};

export async function uninstallService(
  options: ServiceManagerOptions,
): Promise<void> {
  if (options.platform === "darwin") {
    const domain = `gui/${options.uid ?? process.getuid?.()}`;
    const target = `${domain}/${options.paths.launchdLabel}`;
    const status = await runAllowFailure("launchctl", [
      "print",
      target,
    ]);
    const pid = launchdPid(status.stdout);
    await runAllowFailure("launchctl", [
      "bootout",
      target,
    ]);
    if (pid !== undefined) {
      await waitForPidExit(pid, 30_000);
    }
    await rm(options.paths.launchAgentPath, { force: true });
    return;
  }
  if (options.platform === "linux") {
    await runAllowFailure("systemctl", [
      "--user",
      "disable",
      "--now",
      `${options.paths.serviceName}.service`,
    ]);
    await rm(options.paths.systemdUnitPath, { force: true });
    await runAllowFailure("systemctl", ["--user", "daemon-reload"]);
    return;
  }
  throw new Error(
    `Automatic background service removal is not supported on ${options.platform}.`,
  );
}

export async function getServiceStatus(
  options: ServiceManagerOptions,
): Promise<ServiceStatus> {
  if (options.platform === "darwin") {
    const installed = await fileExists(options.paths.launchAgentPath);
    const domain = `gui/${options.uid ?? process.getuid?.()}`;
    const result = await runAllowFailure("launchctl", [
      "print",
      `${domain}/${options.paths.launchdLabel}`,
    ]);
    return {
      manager: "launchd",
      installed,
      running: result.code === 0 && /\bstate = running\b/.test(result.stdout),
      detail: result.code === 0 ? undefined : result.stderr.trim(),
    };
  }
  if (options.platform === "linux") {
    const installed = await fileExists(options.paths.systemdUnitPath);
    const result = await runAllowFailure("systemctl", [
      "--user",
      "is-active",
      `${options.paths.serviceName}.service`,
    ]);
    return {
      manager: "systemd",
      installed,
      running: result.code === 0 && result.stdout.trim() === "active",
      detail: result.code === 0 ? undefined : result.stderr.trim(),
    };
  }
  throw new Error(`Service status is not supported on ${options.platform}.`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function runAllowFailure(
  command: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        resolve({
          code: 127,
          stdout,
          stderr: error.message,
        });
        return;
      }
      reject(error);
    });
    child.once("exit", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function launchdPid(output: string): number | undefined {
  const match = output.match(/^\s*pid = (\d+)\s*$/m);
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

async function waitForPidExit(
  pid: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for launchd process ${pid} to exit`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    ) {
      return false;
    }
    throw error;
  }
}
