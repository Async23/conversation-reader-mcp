import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  configureClients,
  removeClientConfigurations,
} from "../src/client-config.js";
import { PACKAGE_VERSION } from "../src/version.js";

test("updates JSON client config without replacing unrelated settings", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "read-my-chatgpt-client-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, ".cursor", "mcp.json");
  await mkdir(join(home, ".cursor"), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      theme: "dark",
      mcpServers: {
        existing: { command: "existing-server" },
        "conversation-reader": { command: "legacy-server" },
      },
    }),
  );

  const [result] = await configureClients({
    homeDirectory: home,
    endpoint: "http://127.0.0.1:47831/mcp",
    bearerToken: "mcp-secret",
    clients: ["cursor"],
    env: {},
  });

  assert.equal(result.configured, true);
  assert.equal(
    result.backupPath?.endsWith("/.cursor/mcp.json.bak"),
    true,
  );
  const config = JSON.parse(await readFile(path, "utf8")) as {
    theme: string;
    mcpServers: Record<string, unknown>;
  };
  assert.equal(config.theme, "dark");
  assert.deepEqual(config.mcpServers.existing, {
    command: "existing-server",
  });
  assert.equal(config.mcpServers["conversation-reader"], undefined);
  assert.deepEqual(config.mcpServers["read-my-chatgpt"], {
    url: "http://127.0.0.1:47831/mcp",
    headers: { Authorization: "Bearer mcp-secret" },
  });
  assert.match(
    await readFile(`${path}.bak`, "utf8"),
    /legacy-server/,
  );
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(`${path}.bak`)).mode & 0o777, 0o600);
});

test("surgically updates Codex TOML and removes the legacy server", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "read-my-chatgpt-codex-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, ".codex", "config.toml");
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(
    path,
    `model = "gpt-test"

[mcp_servers.conversation-reader]
url = "http://old.invalid/mcp"

[mcp_servers.other]
command = "other"
`,
  );

  const [result] = await configureClients({
    homeDirectory: home,
    endpoint: "http://127.0.0.1:47831/mcp",
    bearerToken: 'quote"and\\slash',
    clients: ["codex"],
    env: {},
  });

  assert.equal(result.configured, true);
  const contents = await readFile(path, "utf8");
  assert.match(contents, /model = "gpt-test"/);
  assert.match(contents, /\[mcp_servers\.other\]/);
  assert.doesNotMatch(contents, /\[mcp_servers\.conversation-reader\]/);
  assert.match(contents, /\[mcp_servers\.read-my-chatgpt\]/);
  assert.match(contents, /http_headers = \{ Authorization = /);
  assert.match(contents, /quote\\"and\\\\slash/);
});

test("refuses invalid JSON and leaves the original untouched", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "read-my-chatgpt-invalid-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, ".claude.json");
  await writeFile(path, "{ invalid json\n");

  const [result] = await configureClients({
    homeDirectory: home,
    endpoint: "http://127.0.0.1:47831/mcp",
    bearerToken: "mcp-secret",
    clients: ["claude"],
    env: {},
  });

  assert.equal(result.configured, false);
  assert.match(result.reason ?? "", /invalid JSON/);
  assert.equal(await readFile(path, "utf8"), "{ invalid json\n");
});

test("auto mode only configures detected client directories", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "read-my-chatgpt-auto-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".gemini"), { recursive: true });

  const results = await configureClients({
    homeDirectory: home,
    endpoint: "http://127.0.0.1:47831/mcp",
    bearerToken: "mcp-secret",
    clients: "auto",
    env: {},
  });

  assert.deepEqual(
    results.map((result) => result.client),
    ["gemini"],
  );
  assert.equal(results[0]?.configured, true);
});

test("uninstall cleanup removes only this MCP entry", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "read-my-chatgpt-remove-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, ".cursor", "mcp.json");
  await mkdir(join(home, ".cursor"), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      mcpServers: {
        existing: { command: "keep-me" },
        "read-my-chatgpt": {
          url: "http://127.0.0.1:47831/mcp",
        },
      },
    }),
  );

  const [result] = await removeClientConfigurations({
    homeDirectory: home,
    clients: ["cursor"],
    env: {},
  });

  assert.equal(result.configured, true);
  const config = JSON.parse(await readFile(path, "utf8")) as {
    mcpServers: Record<string, unknown>;
  };
  assert.deepEqual(config.mcpServers, {
    existing: { command: "keep-me" },
  });
});

test("writes each supported client's current remote HTTP shape", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "read-my-chatgpt-shapes-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { XDG_CONFIG_HOME: join(home, ".config") };

  const results = await configureClients({
    homeDirectory: home,
    endpoint: "http://127.0.0.1:47831/mcp",
    bearerToken: "mcp-secret",
    clients: "all",
    env,
  });
  assert.equal(results.length, 7);
  assert.ok(results.every((result) => result.configured));

  const claude = JSON.parse(
    await readFile(join(home, ".claude.json"), "utf8"),
  );
  assert.deepEqual(claude.mcpServers["read-my-chatgpt"], {
    type: "http",
    url: "http://127.0.0.1:47831/mcp",
    headers: { Authorization: "Bearer mcp-secret" },
  });

  const gemini = JSON.parse(
    await readFile(join(home, ".gemini", "settings.json"), "utf8"),
  );
  assert.deepEqual(gemini.mcpServers["read-my-chatgpt"], {
    httpUrl: "http://127.0.0.1:47831/mcp",
    headers: { Authorization: "Bearer mcp-secret" },
    timeout: 60_000,
  });

  const opencode = JSON.parse(
    await readFile(
      join(home, ".config", "opencode", "opencode.json"),
      "utf8",
    ),
  );
  assert.equal(opencode.mcp["read-my-chatgpt"].type, "remote");
  assert.equal(opencode.mcp["read-my-chatgpt"].oauth, false);

  const pi = JSON.parse(
    await readFile(join(home, ".pi", "agent", "mcp.json"), "utf8"),
  );
  assert.equal(pi.mcpServers["read-my-chatgpt"].directTools, true);
  assert.equal(pi.mcpServers["read-my-chatgpt"].auth, undefined);

  const grok = await readFile(join(home, ".grok", "config.toml"), "utf8");
  assert.match(grok, /\[mcp_servers\.read-my-chatgpt\]/);
  assert.match(grok, /\[mcp_servers\.read-my-chatgpt\.headers\]/);
});

test("writes each supported client's pinned stdio connector shape", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "read-my-chatgpt-stdio-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { XDG_CONFIG_HOME: join(home, ".config") };
  const launcher = {
    command: "npx",
    args: [
      "-y",
      `read-my-chatgpt@${PACKAGE_VERSION}`,
      "connect",
    ],
  };

  const results = await configureClients({
    homeDirectory: home,
    launcher,
    clients: "all",
    env,
  });
  assert.equal(results.length, 7);
  assert.ok(results.every((result) => result.configured));

  const claude = JSON.parse(
    await readFile(join(home, ".claude.json"), "utf8"),
  );
  assert.deepEqual(
    claude.mcpServers["read-my-chatgpt"],
    launcher,
  );

  const cursor = JSON.parse(
    await readFile(join(home, ".cursor", "mcp.json"), "utf8"),
  );
  assert.deepEqual(
    cursor.mcpServers["read-my-chatgpt"],
    launcher,
  );

  const gemini = JSON.parse(
    await readFile(join(home, ".gemini", "settings.json"), "utf8"),
  );
  assert.deepEqual(gemini.mcpServers["read-my-chatgpt"], {
    ...launcher,
    timeout: 60_000,
  });

  const opencode = JSON.parse(
    await readFile(
      join(home, ".config", "opencode", "opencode.json"),
      "utf8",
    ),
  );
  assert.deepEqual(opencode.mcp["read-my-chatgpt"], {
    type: "local",
    command: ["npx", ...launcher.args],
    enabled: true,
    timeout: 60_000,
  });

  const pi = JSON.parse(
    await readFile(join(home, ".pi", "agent", "mcp.json"), "utf8"),
  );
  assert.deepEqual(pi.mcpServers["read-my-chatgpt"], {
    ...launcher,
    directTools: true,
  });

  const codex = await readFile(
    join(home, ".codex", "config.toml"),
    "utf8",
  );
  assert.match(codex, /command = "npx"/);
  assert.ok(
    codex.includes(
      `args = ["-y", "read-my-chatgpt@${PACKAGE_VERSION}", "connect"]`,
    ),
  );
  assert.doesNotMatch(codex, /Authorization/);

  const grok = await readFile(
    join(home, ".grok", "config.toml"),
    "utf8",
  );
  assert.match(grok, /command = "npx"/);
  assert.ok(
    grok.includes(
      `args = ["-y", "read-my-chatgpt@${PACKAGE_VERSION}", "connect"]`,
    ),
  );
  assert.doesNotMatch(grok, /headers|Authorization/);
});

test("updates a symlink target without replacing the symlink", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "read-my-chatgpt-symlink-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dotfiles = join(home, "dotfiles");
  const target = join(dotfiles, "cursor-mcp.json");
  const path = join(home, ".cursor", "mcp.json");
  await mkdir(dotfiles, { recursive: true });
  await mkdir(join(home, ".cursor"), { recursive: true });
  await writeFile(target, '{"mcpServers":{}}\n');
  await symlink(target, path);

  const [result] = await configureClients({
    homeDirectory: home,
    endpoint: "http://127.0.0.1:47831/mcp",
    bearerToken: "mcp-secret",
    clients: ["cursor"],
    env: {},
  });

  assert.equal(result.configured, true);
  assert.equal((await lstat(path)).isSymbolicLink(), true);
  assert.match(await readFile(target, "utf8"), /read-my-chatgpt/);
});
