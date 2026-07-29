import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  managedObscuraBinaryPath,
  obscuraAssetFor,
  sha256,
  validateObscuraBinary,
} from "../src/obscura-installer.js";
import {
  readServiceEnvironment,
  writeServiceEnvironment,
} from "../src/service-config.js";

test("maps supported Obscura assets and rejects unsupported platforms", () => {
  const asset = obscuraAssetFor("darwin", "arm64");
  assert.equal(asset.filename, "obscura-aarch64-macos.tar.gz");
  assert.match(asset.sha256, /^[a-f0-9]{64}$/);
  assert.throws(() => obscuraAssetFor("win32", "arm64"), /not available/);
  assert.equal(
    sha256(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("uses an XDG-scoped managed Obscura path", () => {
  assert.equal(
    managedObscuraBinaryPath({
      env: { XDG_DATA_HOME: "/tmp/example-data" },
      homeDirectory: "/home/example",
      platform: "linux",
      arch: "x64",
    }),
    "/tmp/example-data/read-my-chatgpt/obscura/v0.1.10/linux-x64/obscura",
  );
});

test("validates the required Obscura CLI features", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "read-my-chatgpt-bin-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, "obscura");
  await writeFile(
    binary,
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
  await chmod(binary, 0o700);

  await validateObscuraBinary(binary, true);
});

test("writes service secrets privately and validates their keys", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "read-my-chatgpt-env-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "nested", "service.json");

  await writeServiceEnvironment(path, {
    READ_MY_CHATGPT_ACCESS_TOKEN: "private-token",
    READ_MY_CHATGPT_MCP_PORT: "47831",
  });

  assert.deepEqual(await readServiceEnvironment(path), {
    READ_MY_CHATGPT_ACCESS_TOKEN: "private-token",
    READ_MY_CHATGPT_MCP_PORT: "47831",
  });
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  await writeFile(path, '{"PATH":"/tmp"}\n');
  await assert.rejects(
    () => readServiceEnvironment(path),
    /Unsupported service config key/,
  );
});
