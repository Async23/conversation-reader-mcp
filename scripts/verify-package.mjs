import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(
  join(tmpdir(), "read-my-chatgpt-package-"),
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    ...options,
  });
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`,
  );
  return result;
}

async function runLifecycle(executable, temporaryRoot, packageVersion) {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    console.error(
      `verify-package.mjs: skipping service lifecycle on ${process.platform}`,
    );
    return;
  }

  const lifecycleRoot = join(temporaryRoot, "lifecycle");
  const home = join(lifecycleRoot, "home");
  const fakeBin = join(lifecycleRoot, "bin");
  const serviceLog = join(lifecycleRoot, "service-manager.log");
  const healthScript = join(lifecycleRoot, "health-server.mjs");
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });

  const managerName =
    process.platform === "darwin" ? "launchctl" : "systemctl";
  const managerPath = join(fakeBin, managerName);
  writeFileSync(
    managerPath,
    `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_SERVICE_LOG"
if [ "$1" = "print" ]; then
  exit 1
fi
if [ "$1" = "--user" ] && [ "$2" = "is-active" ]; then
  exit 1
fi
exit 0
`,
  );
  chmodSync(managerPath, 0o700);

  const obscuraPath = join(fakeBin, "obscura");
  writeFileSync(
    obscuraPath,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'obscura 0.1.10\n'
elif [ "$1" = "serve" ] && [ "$2" = "--help" ]; then
  printf '%s\n' '--host --port --storage-dir --quiet --stealth'
else
  exit 2
fi
`,
  );
  chmodSync(obscuraPath, 0o700);

  writeFileSync(
    healthScript,
    `import { createServer } from "node:http";

const server = createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      status: "ok",
      server: "read-my-chatgpt",
    }));
    return;
  }
  response.writeHead(404);
  response.end();
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") process.exit(2);
  process.stdout.write(String(address.port) + "\\n");
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
`,
  );

  const health = spawn(process.execPath, [healthScript], {
    cwd: lifecycleRoot,
    stdio: ["ignore", "pipe", "inherit"],
  });

  try {
    const port = await firstLine(health);
    assert.match(port, /^\d+$/);

    const cleanEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("READ_MY_CHATGPT_"),
      ),
    );
    const xdgConfigHome = join(home, ".config");
    const xdgDataHome = join(home, ".local", "share");
    const legacyConfigDirectory = join(
      xdgConfigHome,
      "conversation-reader-mcp",
    );
    const legacyDataDirectory = join(
      xdgDataHome,
      "conversation-reader-mcp",
    );
    const legacyStorageDirectory = join(
      legacyDataDirectory,
      "obscura-profile",
    );
    const legacyObscuraPath = join(
      legacyDataDirectory,
      "obscura",
      "v0.1.10",
      `${process.platform}-${process.arch}`,
      "obscura",
    );
    mkdirSync(legacyConfigDirectory, { recursive: true });
    mkdirSync(legacyStorageDirectory, { recursive: true });
    mkdirSync(dirname(legacyObscuraPath), { recursive: true });
    copyFileSync(obscuraPath, legacyObscuraPath);
    chmodSync(legacyObscuraPath, 0o700);
    writeFileSync(
      join(legacyStorageDirectory, "migration-marker"),
      "preserve me\n",
    );
    writeFileSync(
      join(legacyConfigDirectory, "service.json"),
      `${JSON.stringify(
        {
          READ_MY_CHATGPT_ACCESS_TOKEN: "legacy-access-token",
          READ_MY_CHATGPT_TRANSPORT: "obscura",
          READ_MY_CHATGPT_OBSCURA_BIN: legacyObscuraPath,
          READ_MY_CHATGPT_OBSCURA_STORAGE_DIR:
            legacyStorageDirectory,
          READ_MY_CHATGPT_MCP_TRANSPORT: "http",
          READ_MY_CHATGPT_MCP_HOST: "127.0.0.1",
          READ_MY_CHATGPT_MCP_PORT: port,
          READ_MY_CHATGPT_MCP_BEARER_TOKEN:
            "legacy-mcp-token",
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    const legacyServiceDefinition =
      process.platform === "darwin"
        ? join(
            home,
            "Library",
            "LaunchAgents",
            "io.github.async23.conversation-reader-mcp.plist",
          )
        : join(
            xdgConfigHome,
            "systemd",
            "user",
            "conversation-reader-mcp.service",
          );
    mkdirSync(dirname(legacyServiceDefinition), { recursive: true });
    writeFileSync(legacyServiceDefinition, "legacy service\n");

    const env = {
      ...cleanEnvironment,
      HOME: home,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_DATA_HOME: xdgDataHome,
      PATH: [
        fakeBin,
        dirname(process.execPath),
        process.env.PATH,
      ]
        .filter(Boolean)
        .join(delimiter),
      FAKE_SERVICE_LOG: serviceLog,
    };

    const invalidPort = spawnSync(
      executable,
      ["init", "--yes", "--port", "0"],
      {
        cwd: lifecycleRoot,
        encoding: "utf8",
        env,
        timeout: 30_000,
      },
    );
    assert.ifError(invalidPort.error);
    assert.equal(invalidPort.status, 1);
    assert.match(invalidPort.stderr, /--port must be an integer/);

    const init = run(
      executable,
      [
        "init",
        "--yes",
        "--no-configure",
        "--port",
        port,
      ],
      { cwd: lifecycleRoot, env },
    );
    assert.match(init.stdout, /read-my-chatgpt is initialized/);
    assert.match(
      init.stderr,
      /Migrated the previous conversation-reader-mcp installation/,
    );

    const serviceConfigPath = join(
      xdgConfigHome,
      "read-my-chatgpt",
      "service.json",
    );
    const serviceConfig = JSON.parse(
      readFileSync(serviceConfigPath, "utf8"),
    );
    assert.equal(
      serviceConfig.READ_MY_CHATGPT_ACCESS_TOKEN,
      "legacy-access-token",
    );
    assert.equal(
      serviceConfig.READ_MY_CHATGPT_MCP_BEARER_TOKEN,
      "legacy-mcp-token",
    );
    assert.equal(serviceConfig.READ_MY_CHATGPT_MCP_PORT, port);
    assert.equal(
      serviceConfig.READ_MY_CHATGPT_DAEMON_IDLE_MS,
      "600000",
    );
    assert.equal(
      serviceConfig.READ_MY_CHATGPT_DAEMON_START_TIMEOUT_MS,
      "120000",
    );
    assert.equal(
      serviceConfig.READ_MY_CHATGPT_OBSCURA_BIN,
      join(
        xdgDataHome,
        "read-my-chatgpt",
        "obscura",
        "v0.1.10",
        `${process.platform}-${process.arch}`,
        "obscura",
      ),
    );
    assert.equal(
      serviceConfig.READ_MY_CHATGPT_OBSCURA_STORAGE_DIR,
      join(xdgDataHome, "read-my-chatgpt", "obscura-profile"),
    );
    assert.equal(statSync(serviceConfigPath).mode & 0o777, 0o600);
    assert.equal(existsSync(legacyConfigDirectory), false);
    assert.equal(existsSync(legacyDataDirectory), false);
    assert.equal(existsSync(legacyServiceDefinition), false);
    assert.equal(
      readFileSync(
        join(
          xdgDataHome,
          "read-my-chatgpt",
          "obscura-profile",
          "migration-marker",
        ),
        "utf8",
      ),
      "preserve me\n",
    );

    const serviceDefinition =
      process.platform === "darwin"
        ? join(
            home,
            "Library",
            "LaunchAgents",
            "io.github.async23.read-my-chatgpt.plist",
          )
        : join(
            xdgConfigHome,
            "systemd",
            "user",
            "read-my-chatgpt.service",
          );
    assert.equal(existsSync(serviceDefinition), false);

    const configure = run(executable, ["configure", "cursor"], {
      cwd: lifecycleRoot,
      env,
    });
    assert.match(configure.stdout, /cursor/);
    const cursorConfigPath = join(home, ".cursor", "mcp.json");
    const cursorConfig = JSON.parse(
      readFileSync(cursorConfigPath, "utf8"),
    );
    assert.deepEqual(
      cursorConfig.mcpServers["read-my-chatgpt"],
      {
        command: "npx",
        args: [
          "-y",
          `read-my-chatgpt@${packageVersion}`,
          "connect",
        ],
      },
    );

    await stopChild(health);
    const doctor = run(executable, ["doctor", "--json"], {
      cwd: lifecycleRoot,
      env,
    });
    const diagnosis = JSON.parse(doctor.stdout);
    assert.equal(diagnosis.ok, true);
    assert.ok(
      diagnosis.checks.every((check) => check.ok),
      JSON.stringify(diagnosis.checks),
    );

    const uninstall = run(
      executable,
      ["uninstall", "--purge", "--yes"],
      { cwd: lifecycleRoot, env },
    );
    assert.match(uninstall.stdout, /Local configuration and data removed/);
    assert.equal(existsSync(serviceConfigPath), false);
    assert.equal(existsSync(serviceDefinition), false);
    assert.doesNotMatch(
      readFileSync(cursorConfigPath, "utf8"),
      /read-my-chatgpt/,
    );

    const managerCommands = readFileSync(serviceLog, "utf8");
    assert.doesNotMatch(
      managerCommands,
      process.platform === "darwin"
        ? /\bbootstrap\b|\bkickstart\b/
        : /\benable --now\b/,
    );
    assert.match(
      managerCommands,
      process.platform === "darwin" ? /bootout/ : /disable --now/,
    );
  } finally {
    await stopChild(health);
  }
}

function firstLine(child) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("health server did not report a port"));
    }, 10_000);
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onData = (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolve(buffer.slice(0, newline).trim());
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code) => {
      cleanup();
      reject(
        new Error(`health server exited before ready with code ${code}`),
      );
    };
    child.stdout?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

try {
  const packDirectory = join(temporaryRoot, "pack");
  const installDirectory = join(temporaryRoot, "install");
  mkdirSync(packDirectory, { recursive: true });
  const packResult = run("npm", [
    "pack",
    "--pack-destination",
    packDirectory,
    "--silent",
  ]);
  const tarballName = packResult.stdout.trim().split(/\r?\n/).at(-1);
  assert.ok(tarballName, "npm pack did not report a tarball");
  const tarballPath = join(packDirectory, tarballName);
  const listing = run("tar", ["-tzf", tarballPath]).stdout;
  assert.match(listing, /package\/README\.md/);
  assert.match(listing, /package\/LICENSE/);
  assert.match(listing, /package\/CHANGELOG\.md/);
  assert.match(listing, /package\/THIRD_PARTY_NOTICES\.md/);
  assert.match(listing, /package\/licenses\/OBSCURA-APACHE-2\.0\.txt/);
  assert.match(listing, /package\/dist\/install-migration\.js/);
  assert.match(listing, /package\/dist\/obscura-installer\.js/);
  assert.match(listing, /package\/dist\/connector\.js/);
  assert.match(listing, /package\/dist\/daemon-client\.js/);
  assert.doesNotMatch(listing, /package\/src\//);
  assert.doesNotMatch(listing, /package\/\.env$/m);
  assert.notEqual(
    statSync(join(root, "dist", "index.js")).mode & 0o111,
    0,
    "dist/index.js must remain executable after a clean build",
  );

  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--omit=dev",
      "--silent",
      "--prefix",
      installDirectory,
      tarballPath,
    ],
    { cwd: temporaryRoot },
  );

  const installedPackageDirectory = join(
    installDirectory,
    "node_modules",
    "read-my-chatgpt",
  );
  const installedPackage = JSON.parse(
    readFileSync(join(installedPackageDirectory, "package.json"), "utf8"),
  );
  assert.equal(installedPackage.name, "read-my-chatgpt");
  const binTarget =
    installedPackage.bin?.["read-my-chatgpt"];
  assert.equal(binTarget, "dist/index.js");
  assert.match(
    readFileSync(join(installedPackageDirectory, ".env.example"), "utf8"),
    /READ_MY_CHATGPT_ACCESS_TOKEN=/,
  );

  const executable = join(
    installDirectory,
    "node_modules",
    ".bin",
    "read-my-chatgpt",
  );
  const help = run(executable, ["--help"], { cwd: temporaryRoot });
  assert.match(help.stdout, /read-my-chatgpt init/);
  const version = run(executable, ["--version"], {
    cwd: temporaryRoot,
  });
  assert.equal(version.stdout.trim(), installedPackage.version);

  const smoke = spawnSync(executable, [], {
    cwd: temporaryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      READ_MY_CHATGPT_ACCESS_TOKEN: "test-token",
      READ_MY_CHATGPT_TRANSPORT: "direct",
    },
    input: "",
    timeout: 5_000,
  });
  assert.ifError(smoke.error);
  assert.equal(smoke.status, 0, smoke.stderr || smoke.stdout);
  assert.match(
    smoke.stderr,
    /\[read-my-chatgpt\] ready on stdio/,
  );

  await runLifecycle(
    executable,
    temporaryRoot,
    installedPackage.version,
  );

  console.error("verify-package.mjs: ok");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
