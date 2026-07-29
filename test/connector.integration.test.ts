import assert from "node:assert/strict";
import http from "node:http";
import { createServer } from "node:net";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startHttpMcpServer } from "../src/http-server.js";
import type { ReadMyChatGptRuntime } from "../src/runtime.js";
import { listConversationsToolDefinition } from "../src/tool-definitions.js";

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !entry[0].startsWith("READ_MY_CHATGPT_"),
    ),
  );
}

let nextLoopbackPort = 20_000 + (process.pid % 10_000);

async function unusedLoopbackPort(): Promise<number> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const port = nextLoopbackPort;
    nextLoopbackPort =
      nextLoopbackPort === 29_999 ? 20_000 : nextLoopbackPort + 1;
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", onError);
          resolve();
        });
      });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "EADDRINUSE"
      ) {
        continue;
      }
      throw error;
    }
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    return port;
  }
  throw new Error("Could not find an unused loopback test port");
}

function parseTextResult(
  result: Awaited<ReturnType<Client["callTool"]>>,
): Record<string, unknown> {
  const content = result.content;
  assert.ok(Array.isArray(content));
  const first = content[0];
  assert.ok(first && first.type === "text");
  return JSON.parse(first.text) as Record<string, unknown>;
}

async function waitForDaemonToStop(port: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(100),
      });
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`daemon on port ${port} did not stop`);
}

test(
  "command connector lists tools without starting the shared daemon",
  { timeout: 10_000 },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "read-my-chatgpt-connector-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const daemonPort = await unusedLoopbackPort();
    const configPath = join(home, "service.json");
    await writeFile(
      configPath,
      `${JSON.stringify({
        READ_MY_CHATGPT_ACCESS_TOKEN: "test-token",
        READ_MY_CHATGPT_BASE_URL: "http://127.0.0.1:9",
        READ_MY_CHATGPT_TRANSPORT: "direct",
        READ_MY_CHATGPT_MCP_TRANSPORT: "http",
        READ_MY_CHATGPT_MCP_HOST: "127.0.0.1",
        READ_MY_CHATGPT_MCP_PORT: String(daemonPort),
        READ_MY_CHATGPT_MCP_BEARER_TOKEN: "connector-test-secret",
      })}\n`,
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        "src/index.ts",
        "connect",
        "--config",
        configPath,
      ],
      cwd: process.cwd(),
      env: inheritedEnvironment(),
      stderr: "pipe",
    });
    const client = new Client({
      name: "connector-test-client",
      version: "1.0.0",
    });
    t.after(() => client.close());

    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [
        "get_asset",
        "get_conversation",
        "list_conversations",
        "search_conversations",
      ],
    );
    const listTool = tools.tools.find(
      (tool) => tool.name === "list_conversations",
    );
    assert.match(
      listTool?.description ?? "",
      /created_at and updated_at are RFC 3339 timestamps in UTC/,
    );
    assert.match(
      JSON.stringify(listTool?.inputSchema),
      /Pagination offset \(default 0\)/,
    );

    await assert.rejects(
      fetch(`http://127.0.0.1:${daemonPort}/healthz`, {
        signal: AbortSignal.timeout(250),
      }),
    );
  },
);

test(
  "connector does not reveal its bearer token to a forged health endpoint",
  { timeout: 10_000 },
  async (t) => {
    const authorizations: string[] = [];
    const forgedDaemon = http.createServer((request, response) => {
      if (request.url === "/healthz") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            status: "ok",
            server: "read-my-chatgpt",
          }),
        );
        return;
      }

      if (request.headers.authorization) {
        authorizations.push(request.headers.authorization);
      }
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_the_daemon" }));
    });
    await new Promise<void>((resolve) =>
      forgedDaemon.listen(0, "127.0.0.1", resolve),
    );
    const forgedAddress = forgedDaemon.address();
    assert.ok(forgedAddress && typeof forgedAddress === "object");

    const home = await mkdtemp(join(tmpdir(), "read-my-chatgpt-forged-"));
    const configPath = join(home, "service.json");
    await writeFile(
      configPath,
      `${JSON.stringify({
        READ_MY_CHATGPT_ACCESS_TOKEN: "test-token",
        READ_MY_CHATGPT_BASE_URL: "http://127.0.0.1:9",
        READ_MY_CHATGPT_TRANSPORT: "direct",
        READ_MY_CHATGPT_MCP_TRANSPORT: "http",
        READ_MY_CHATGPT_MCP_HOST: "127.0.0.1",
        READ_MY_CHATGPT_MCP_PORT: String(forgedAddress.port),
        READ_MY_CHATGPT_MCP_BEARER_TOKEN: "must-not-leak",
      })}\n`,
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        "src/index.ts",
        "connect",
        "--config",
        configPath,
      ],
      cwd: process.cwd(),
      env: inheritedEnvironment(),
      stderr: "pipe",
    });
    const client = new Client({
      name: "forged-health-client",
      version: "1.0.0",
    });
    t.after(async () => {
      await client.close().catch(() => undefined);
      await new Promise<void>((resolve, reject) =>
        forgedDaemon.close((error) =>
          error ? reject(error) : resolve(),
        ),
      );
      await rm(home, { recursive: true, force: true });
    });

    await client.connect(transport);
    await client
      .callTool({
        name: "list_conversations",
        arguments: { limit: 1 },
      })
      .catch(() => undefined);

    assert.deepEqual(authorizations, []);
  },
);

test(
  "connector reaps a detached daemon process group when startup times out",
  { timeout: 12_000 },
  async (t) => {
    if (process.platform === "win32") {
      t.skip("process-group lifecycle assertions require POSIX signals");
      return;
    }

    const home = await mkdtemp(join(tmpdir(), "read-my-chatgpt-timeout-"));
    const processLog = join(home, "processes.log");
    const entrypoint = join(home, "entrypoint.mjs");
    const sourceEntrypoint = new URL(
      "../src/index.ts",
      import.meta.url,
    ).href;
    await writeFile(
      entrypoint,
      `import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

if (process.argv[2] === "daemon") {
  process.on("SIGTERM", () => {});
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
    ],
    { stdio: "ignore" },
  );
  appendFileSync(
    process.env.READ_MY_CHATGPT_TEST_PROCESS_LOG,
    String(process.pid) + " " + String(child.pid) + "\\n",
  );
  setInterval(() => {}, 1_000);
} else {
  await import(${JSON.stringify(sourceEntrypoint)});
}
`,
    );

    const daemonPort = await unusedLoopbackPort();
    const configPath = join(home, "service.json");
    await writeFile(
      configPath,
      `${JSON.stringify({
        READ_MY_CHATGPT_ACCESS_TOKEN: "test-token",
        READ_MY_CHATGPT_TRANSPORT: "direct",
        READ_MY_CHATGPT_MCP_TRANSPORT: "http",
        READ_MY_CHATGPT_MCP_HOST: "127.0.0.1",
        READ_MY_CHATGPT_MCP_PORT: String(daemonPort),
        READ_MY_CHATGPT_MCP_BEARER_TOKEN: "timeout-test-secret",
        READ_MY_CHATGPT_DAEMON_START_TIMEOUT_MS: "2000",
      })}\n`,
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        entrypoint,
        "connect",
        "--config",
        configPath,
      ],
      cwd: process.cwd(),
      env: {
        ...inheritedEnvironment(),
        READ_MY_CHATGPT_TEST_PROCESS_LOG: processLog,
      },
      stderr: "pipe",
    });
    const client = new Client({
      name: "startup-timeout-client",
      version: "1.0.0",
    });
    const daemonProcessGroups = new Set<number>();
    t.after(async () => {
      await client.close().catch(() => undefined);
      for (const processGroup of daemonProcessGroups) {
        try {
          process.kill(-processGroup, "SIGKILL");
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "ESRCH"
          ) {
            throw error;
          }
        }
      }
      await rm(home, { recursive: true, force: true });
    });

    await client.connect(transport);
    await client
      .callTool({
        name: "list_conversations",
        arguments: { limit: 1 },
      })
      .catch(() => undefined);

    const recorded = await waitForRecordedProcesses(processLog);
    for (const { daemonPid } of recorded) {
      daemonProcessGroups.add(daemonPid);
    }
    const deadline = Date.now() + 2_500;
    while (
      Date.now() < deadline &&
      recorded.some(({ daemonPid }) =>
        processGroupIsAlive(daemonPid),
      )
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual(
      recorded.filter(({ daemonPid }) =>
        processGroupIsAlive(daemonPid),
      ),
      [],
    );
  },
);

test(
  "closing a connector during a tool call does not retry the call",
  { timeout: 10_000 },
  async (t) => {
    let backendRequests = 0;
    const backend = http.createServer((_request, response) => {
      backendRequests += 1;
      setTimeout(() => {
        response.writeHead(200, {
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify({
            items: [],
            total: 0,
            offset: 0,
            limit: 1,
          }),
        );
      }, 400);
    });
    await new Promise<void>((resolve) =>
      backend.listen(0, "127.0.0.1", resolve),
    );
    const backendAddress = backend.address();
    assert.ok(backendAddress && typeof backendAddress === "object");

    const home = await mkdtemp(join(tmpdir(), "read-my-chatgpt-close-"));
    const daemonPort = await unusedLoopbackPort();
    const configPath = join(home, "service.json");
    await writeFile(
      configPath,
      `${JSON.stringify({
        READ_MY_CHATGPT_ACCESS_TOKEN: "test-token",
        READ_MY_CHATGPT_BASE_URL:
          `http://127.0.0.1:${backendAddress.port}`,
        READ_MY_CHATGPT_TRANSPORT: "direct",
        READ_MY_CHATGPT_MCP_TRANSPORT: "http",
        READ_MY_CHATGPT_MCP_HOST: "127.0.0.1",
        READ_MY_CHATGPT_MCP_PORT: String(daemonPort),
        READ_MY_CHATGPT_MCP_BEARER_TOKEN: "close-test-secret",
        READ_MY_CHATGPT_DAEMON_IDLE_MS: "150",
      })}\n`,
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        "src/index.ts",
        "connect",
        "--config",
        configPath,
      ],
      cwd: process.cwd(),
      env: inheritedEnvironment(),
      stderr: "pipe",
    });
    const client = new Client({
      name: "close-during-call-client",
      version: "1.0.0",
    });
    t.after(async () => {
      await client.close().catch(() => undefined);
      await waitForDaemonToStop(daemonPort).catch(() => undefined);
      await new Promise<void>((resolve, reject) =>
        backend.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(home, { recursive: true, force: true });
    });

    await client.connect(transport);
    const call = client
      .callTool({
        name: "list_conversations",
        arguments: { limit: 1 },
      })
      .catch(() => undefined);
    const requestDeadline = Date.now() + 3_000;
    while (backendRequests === 0 && Date.now() < requestDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(backendRequests, 1);

    await client.close();
    await call;
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(backendRequests, 1);
  },
);

test(
  "connector forwards caller cancellation to the shared daemon",
  { timeout: 10_000 },
  async (t) => {
    let remoteStarted = false;
    let remoteCancelled = false;
    let finishRemote: (() => void) | undefined;
    const runtime = {
      createMcpServer() {
        const server = new McpServer({
          name: "cancellation-test-daemon",
          version: "1.0.0",
        });
        server.registerTool(
          "list_conversations",
          listConversationsToolDefinition("UTC"),
          (_args, extra) =>
            new Promise((resolve) => {
              remoteStarted = true;
              const finish = () => {
                resolve({
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: "cancelled",
                    },
                  ],
                });
              };
              finishRemote = finish;
              extra.signal.addEventListener(
                "abort",
                () => {
                  remoteCancelled = true;
                  finish();
                },
                { once: true },
              );
            }),
        );
        return server;
      },
      async close() {},
    } as unknown as ReadMyChatGptRuntime;
    const running = await startHttpMcpServer(runtime, {
      host: "127.0.0.1",
      port: 0,
      bearerToken: "cancellation-test-secret",
    });

    const home = await mkdtemp(join(tmpdir(), "read-my-chatgpt-cancel-"));
    const configPath = join(home, "service.json");
    await writeFile(
      configPath,
      `${JSON.stringify({
        READ_MY_CHATGPT_ACCESS_TOKEN: "test-token",
        READ_MY_CHATGPT_TRANSPORT: "direct",
        READ_MY_CHATGPT_MCP_TRANSPORT: "http",
        READ_MY_CHATGPT_MCP_HOST: "127.0.0.1",
        READ_MY_CHATGPT_MCP_PORT: String(running.port),
        READ_MY_CHATGPT_MCP_BEARER_TOKEN:
          "cancellation-test-secret",
      })}\n`,
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        "src/index.ts",
        "connect",
        "--config",
        configPath,
      ],
      cwd: process.cwd(),
      env: inheritedEnvironment(),
      stderr: "pipe",
    });
    const client = new Client({
      name: "cancellation-test-client",
      version: "1.0.0",
    });
    t.after(async () => {
      finishRemote?.();
      await client.close().catch(() => undefined);
      await running.close();
      await rm(home, { recursive: true, force: true });
    });

    await client.connect(transport);
    const controller = new AbortController();
    const call = client.callTool(
      {
        name: "list_conversations",
        arguments: { limit: 1 },
      },
      undefined,
      { signal: controller.signal, timeout: 5_000 },
    );
    const startDeadline = Date.now() + 3_000;
    while (!remoteStarted && Date.now() < startDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(remoteStarted, true);

    controller.abort(new Error("caller cancelled"));
    await assert.rejects(call);
    const cancellationDeadline = Date.now() + 1_000;
    while (!remoteCancelled && Date.now() < cancellationDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(remoteCancelled, true);
  },
);

test(
  "concurrent connectors recover a stale start lock and share one daemon",
  { timeout: 15_000 },
  async (t) => {
    let backendRequests = 0;
    const backend = http.createServer((_request, response) => {
      backendRequests += 1;
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            items: [
              {
                id: `shared-${backendRequests}`,
                title: "Shared daemon",
                update_time: backendRequests,
                is_archived: false,
              },
            ],
            total: 1,
            offset: 0,
            limit: 1,
          }),
        );
      }, 350);
    });
    await new Promise<void>((resolve) =>
      backend.listen(0, "127.0.0.1", resolve),
    );
    const backendAddress = backend.address();
    assert.ok(backendAddress && typeof backendAddress === "object");

    const home = await mkdtemp(join(tmpdir(), "read-my-chatgpt-shared-"));
    const daemonPort = await unusedLoopbackPort();
    const configPath = join(home, "service.json");
    await writeFile(
      configPath,
      `${JSON.stringify({
        READ_MY_CHATGPT_ACCESS_TOKEN: "test-token",
        READ_MY_CHATGPT_BASE_URL:
          `http://127.0.0.1:${backendAddress.port}`,
        READ_MY_CHATGPT_TRANSPORT: "direct",
        READ_MY_CHATGPT_MCP_TRANSPORT: "http",
        READ_MY_CHATGPT_MCP_HOST: "127.0.0.1",
        READ_MY_CHATGPT_MCP_PORT: String(daemonPort),
        READ_MY_CHATGPT_MCP_BEARER_TOKEN: "shared-test-secret",
        READ_MY_CHATGPT_DAEMON_IDLE_MS: "200",
      })}\n`,
    );
    const staleLock = `${configPath}.daemon-start.lock`;
    await mkdir(staleLock);
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(staleLock, staleTime, staleTime);

    const createConnector = (name: string) => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          "--import",
          "tsx",
          "src/index.ts",
          "connect",
          "--config",
          configPath,
        ],
        cwd: process.cwd(),
        env: inheritedEnvironment(),
        stderr: "pipe",
      });
      return {
        client: new Client({ name, version: "1.0.0" }),
        transport,
      };
    };
    const first = createConnector("shared-first");
    const second = createConnector("shared-second");
    t.after(async () => {
      await Promise.allSettled([
        first.client.close(),
        second.client.close(),
      ]);
      await waitForDaemonToStop(daemonPort).catch(() => undefined);
      await new Promise<void>((resolve, reject) =>
        backend.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(home, { recursive: true, force: true });
    });

    await Promise.all([
      first.client.connect(first.transport),
      second.client.connect(second.transport),
    ]);
    const calls = Promise.all([
      first.client.callTool({
        name: "list_conversations",
        arguments: { limit: 1 },
      }),
      second.client.callTool({
        name: "list_conversations",
        arguments: { limit: 1 },
      }),
    ]);

    const results = await calls;
    assert.equal(backendRequests, 2);
    assert.equal(results.every((result) => result.isError !== true), true);

    const health = await fetch(
      `http://127.0.0.1:${daemonPort}/healthz`,
    );
    assert.equal(health.status, 200);
    const healthBody = (await health.json()) as { sessions?: unknown };
    assert.equal(healthBody.sessions, 2);

    await waitForDaemonToStop(daemonPort);
  },
);

async function waitForRecordedProcesses(
  path: string,
): Promise<Array<{ daemonPid: number; childPid: number }>> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    try {
      const records = (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [daemonPid, childPid] = line
            .split(" ")
            .map(Number);
          assert.ok(
            Number.isInteger(daemonPid) &&
              daemonPid > 1 &&
              Number.isInteger(childPid) &&
              childPid > 1,
          );
          return { daemonPid, childPid };
        });
      if (records.length > 0) return records;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("timed-out daemon did not launch the fake sidecar");
}

function processGroupIsAlive(processGroup: number): boolean {
  try {
    process.kill(-processGroup, 0);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return false;
    }
    throw error;
  }
}

test(
  "connector starts the daemon on first tool call and restarts it after inactivity",
  { timeout: 15_000 },
  async (t) => {
    let backendRequests = 0;
    const backend = http.createServer((_request, response) => {
      backendRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          items: [
            {
              id: `conversation-${backendRequests}`,
              title: "On demand",
              update_time: backendRequests,
              is_archived: false,
            },
          ],
          total: 1,
          offset: 0,
          limit: 1,
        }),
      );
    });
    await new Promise<void>((resolve) =>
      backend.listen(0, "127.0.0.1", resolve),
    );
    const backendAddress = backend.address();
    assert.ok(backendAddress && typeof backendAddress === "object");
    t.after(
      () =>
        new Promise<void>((resolve, reject) =>
          backend.close((error) => (error ? reject(error) : resolve())),
        ),
    );

    const home = await mkdtemp(join(tmpdir(), "read-my-chatgpt-demand-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const daemonPort = await unusedLoopbackPort();
    const configPath = join(home, "service.json");
    await writeFile(
      configPath,
      `${JSON.stringify({
        READ_MY_CHATGPT_ACCESS_TOKEN: "test-token",
        READ_MY_CHATGPT_BASE_URL:
          `http://127.0.0.1:${backendAddress.port}`,
        READ_MY_CHATGPT_TRANSPORT: "direct",
        READ_MY_CHATGPT_MCP_TRANSPORT: "http",
        READ_MY_CHATGPT_MCP_HOST: "127.0.0.1",
        READ_MY_CHATGPT_MCP_PORT: String(daemonPort),
        READ_MY_CHATGPT_MCP_BEARER_TOKEN: "connector-test-secret",
        READ_MY_CHATGPT_DAEMON_IDLE_MS: "150",
      })}\n`,
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        "src/index.ts",
        "connect",
        "--config",
        configPath,
      ],
      cwd: process.cwd(),
      env: inheritedEnvironment(),
      stderr: "pipe",
    });
    const client = new Client({
      name: "on-demand-test-client",
      version: "1.0.0",
    });
    t.after(() => client.close());

    await client.connect(transport);
    await assert.rejects(
      fetch(`http://127.0.0.1:${daemonPort}/healthz`, {
        signal: AbortSignal.timeout(250),
      }),
    );

    const first = parseTextResult(
      await client.callTool({
        name: "list_conversations",
        arguments: { limit: 1 },
      }),
    );
    assert.deepEqual(
      (first.items as Array<{ id?: string }>).map((item) => item.id),
      ["conversation-1"],
    );

    const firstHealth = await fetch(
      `http://127.0.0.1:${daemonPort}/healthz`,
    );
    assert.equal(firstHealth.status, 200);

    await waitForDaemonToStop(daemonPort);

    const second = parseTextResult(
      await client.callTool({
        name: "list_conversations",
        arguments: { limit: 1 },
      }),
    );
    assert.deepEqual(
      (second.items as Array<{ id?: string }>).map((item) => item.id),
      ["conversation-2"],
    );
    assert.equal(backendRequests, 2);

    const secondHealth = await fetch(
      `http://127.0.0.1:${daemonPort}/healthz`,
    );
    assert.equal(secondHealth.status, 200);

    const shutdown = await fetch(
      `http://127.0.0.1:${daemonPort}/shutdown`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer connector-test-secret",
        },
      },
    );
    assert.equal(shutdown.status, 202);
    const third = parseTextResult(
      await client.callTool({
        name: "list_conversations",
        arguments: { limit: 1 },
      }),
    );
    assert.deepEqual(
      (third.items as Array<{ id?: string }>).map((item) => item.id),
      ["conversation-3"],
    );
    assert.equal(backendRequests, 3);
    await waitForDaemonToStop(daemonPort);
  },
);
