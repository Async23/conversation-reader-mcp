import assert from "node:assert/strict";
import http from "node:http";
import { createServer } from "node:net";
import {
  mkdir,
  mkdtemp,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !entry[0].startsWith("READ_MY_CHATGPT_"),
    ),
  );
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
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
