import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PACKAGE_VERSION } from "../src/version.js";

test("init writes an on-demand connector config and removes the persistent service", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    t.skip("init service migration is supported on macOS and Linux");
    return;
  }

  const home = await mkdtemp(join(tmpdir(), "read-my-chatgpt-init-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configHome = join(home, ".config");
  const dataHome = join(home, ".local", "share");
  const codexHome = join(home, ".codex");
  const binDirectory = join(home, "bin");
  const serviceLog = join(home, "service-manager.log");
  const obscuraBinary = join(binDirectory, "obscura");
  const serviceArtifact =
    process.platform === "darwin"
      ? join(
          home,
          "Library",
          "LaunchAgents",
          "io.github.async23.read-my-chatgpt.plist",
        )
      : join(
          configHome,
          "systemd",
          "user",
          "read-my-chatgpt.service",
        );

  await mkdir(codexHome, { recursive: true });
  await mkdir(binDirectory, { recursive: true });
  await mkdir(join(serviceArtifact, ".."), { recursive: true });
  await writeFile(serviceArtifact, "old persistent service\n");
  await writeFile(
    obscuraBinary,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "obscura 0.1.10"
elif [ "$1" = "serve" ] && [ "$2" = "--help" ]; then
  echo "--host --port --storage-dir --quiet --stealth"
else
  exit 2
fi
`,
  );
  await chmod(obscuraBinary, 0o700);

  const managerName =
    process.platform === "darwin" ? "launchctl" : "systemctl";
  const managerPath = join(binDirectory, managerName);
  await writeFile(
    managerPath,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$READ_MY_CHATGPT_TEST_SERVICE_LOG"
if [ "$1" = "print" ]; then
  exit 1
fi
exit 0
`,
  );
  await chmod(managerPath, 0o700);

  let shutdownRequests = 0;
  const activeDaemon = createHttpServer((request, response) => {
    if (request.url === "/shutdown" && request.method === "POST") {
      assert.equal(
        request.headers.authorization,
        "Bearer old-bearer-token",
      );
      shutdownRequests += 1;
      response.writeHead(202, {
        "content-type": "application/json",
      });
      response.end('{"status":"stopping"}\n', () => {
        activeDaemon.close();
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  activeDaemon.listen(0, "127.0.0.1");
  await once(activeDaemon, "listening");
  t.after(
    () =>
      new Promise<void>((resolve) => {
        if (!activeDaemon.listening) {
          resolve();
          return;
        }
        activeDaemon.close(() => resolve());
      }),
  );
  const activeDaemonAddress = activeDaemon.address();
  assert(activeDaemonAddress && typeof activeDaemonAddress === "object");
  const port = activeDaemonAddress.port;
  const serviceConfigDirectory = join(
    configHome,
    "read-my-chatgpt",
  );
  await mkdir(serviceConfigDirectory, { recursive: true });
  await writeFile(
    join(serviceConfigDirectory, "service.json"),
    `${JSON.stringify({
      READ_MY_CHATGPT_ACCESS_TOKEN: "old-access-token",
      READ_MY_CHATGPT_MCP_TRANSPORT: "http",
      READ_MY_CHATGPT_MCP_HOST: "127.0.0.1",
      READ_MY_CHATGPT_MCP_PORT: String(port),
      READ_MY_CHATGPT_MCP_BEARER_TOKEN: "old-bearer-token",
    })}\n`,
    { mode: 0o600 },
  );
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    CODEX_HOME: codexHome,
    PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
    READ_MY_CHATGPT_ACCESS_TOKEN: "test-access-token",
    READ_MY_CHATGPT_MCP_BEARER_TOKEN: "test-bearer-token",
    READ_MY_CHATGPT_OBSCURA_BIN: obscuraBinary,
    READ_MY_CHATGPT_TEST_SERVICE_LOG: serviceLog,
  };
  delete childEnv.READ_MY_CHATGPT_DAEMON_IDLE_MS;

  const result = await runCli(
    ["init", "--yes", "--port", String(port)],
    childEnv,
  );
  assert.equal(
    result.code,
    0,
    `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.equal(shutdownRequests, 1);

  const serviceConfigPath = join(
    configHome,
    "read-my-chatgpt",
    "service.json",
  );
  const environment = JSON.parse(
    await readFile(serviceConfigPath, "utf8"),
  ) as Record<string, string>;
  assert.equal(
    environment.READ_MY_CHATGPT_ACCESS_TOKEN,
    "test-access-token",
  );
  assert.equal(environment.READ_MY_CHATGPT_MCP_TRANSPORT, "http");
  assert.equal(
    environment.READ_MY_CHATGPT_DAEMON_IDLE_MS,
    "600000",
  );
  assert.equal((await stat(serviceConfigPath)).mode & 0o777, 0o600);

  const codexConfig = await readFile(
    join(codexHome, "config.toml"),
    "utf8",
  );
  assert.match(codexConfig, /command = "npx"/);
  assert.ok(
    codexConfig.includes(
      `args = ["-y", "read-my-chatgpt@${PACKAGE_VERSION}", "connect"]`,
    ),
  );
  assert.doesNotMatch(codexConfig, /url =|Authorization/);

  await assert.rejects(() =>
    fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(250),
    }),
  );
  await assert.rejects(() => stat(serviceArtifact), {
    code: "ENOENT",
  });

  const managerCalls = await readFile(serviceLog, "utf8");
  if (process.platform === "darwin") {
    assert.match(managerCalls, /\bbootout\b/);
    assert.doesNotMatch(managerCalls, /\bbootstrap\b|\bkickstart\b/);
  } else {
    assert.match(managerCalls, /\bdisable --now\b/);
    assert.doesNotMatch(managerCalls, /\benable\b/);
  }

  const doctor = await runCli(["doctor", "--json"], childEnv);
  assert.equal(
    doctor.code,
    0,
    `stdout:\n${doctor.stdout}\nstderr:\n${doctor.stderr}`,
  );
  const diagnosis = JSON.parse(doctor.stdout) as {
    ok: boolean;
    checks: Array<{ name: string; ok: boolean; detail: string }>;
  };
  assert.equal(diagnosis.ok, true);
  assert.deepEqual(
    diagnosis.checks.find(
      (check) => check.name === "persistent-service",
    ),
    {
      name: "persistent-service",
      ok: true,
      detail: "not installed (on-demand mode)",
    },
  );
  assert.deepEqual(
    diagnosis.checks.find(
      (check) => check.name === "on-demand-daemon",
    ),
    {
      name: "on-demand-daemon",
      ok: true,
      detail: "stopped (starts on first tool call)",
    },
  );
});

async function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/index.ts", ...args],
    {
      cwd: new URL("..", import.meta.url),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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
  const [code] = (await once(child, "exit")) as [
    number | null,
    NodeJS.Signals | null,
  ];
  return { code, stdout, stderr };
}
