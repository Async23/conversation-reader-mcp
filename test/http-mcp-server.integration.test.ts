import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/config.js";
import {
  createDaemonHealthChallenge,
  DAEMON_HEALTH_PROTOCOL,
  validDaemonHealthProof,
} from "../src/daemon-health.js";
import { startHttpMcpServer } from "../src/http-server.js";
import { ReadMyChatGptRuntime } from "../src/runtime.js";

const bearerToken = "shared-local-test-token";

function createClient(url: URL, name: string) {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${bearerToken}`,
      },
    },
  });
  const client = new Client({ name, version: "1.0.0" });
  return { client, transport };
}

test("an on-demand daemon exits if its initiating tool never arrives", async () => {
  const config = loadConfig({
    READ_MY_CHATGPT_ACCESS_TOKEN: "test-token",
    READ_MY_CHATGPT_TRANSPORT: "direct",
  });
  const runtime = await ReadMyChatGptRuntime.create(config);
  const running = await startHttpMcpServer(runtime, {
    host: "127.0.0.1",
    port: 0,
    bearerToken,
    toolIdleMs: 100,
  });

  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      running.idle,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("daemon did not idle out")),
          500,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    await running.close();
  }
});

test("one HTTP runtime serves independent authenticated MCP sessions", async () => {
  let backendRequests = 0;
  const backend = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    assert.equal(url.pathname, "/backend-api/conversations");
    backendRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        items: [
          {
            id: `conversation-${backendRequests}`,
            title: "Shared runtime",
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

  const config = loadConfig({
    READ_MY_CHATGPT_ACCESS_TOKEN: "test-token",
    READ_MY_CHATGPT_BASE_URL:
      `http://127.0.0.1:${backendAddress.port}`,
    READ_MY_CHATGPT_TRANSPORT: "direct",
  });
  const runtime = await ReadMyChatGptRuntime.create(config);
  const running = await startHttpMcpServer(runtime, {
    host: "127.0.0.1",
    port: 0,
    bearerToken,
    sessionIdleMs: 500,
    toolIdleMs: 10_000,
  });
  const first = createClient(running.url, "first-client");
  const second = createClient(running.url, "second-client");

  try {
    const health = await fetch(
      new URL("/healthz", running.url),
    );
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      status: "ok",
      server: "read-my-chatgpt",
      transport: "streamable-http",
      sessions: 0,
    });

    const challenge = createDaemonHealthChallenge();
    const challengedHealthUrl = new URL("/healthz", running.url);
    challengedHealthUrl.searchParams.set("challenge", challenge);
    const challengedHealth = await fetch(challengedHealthUrl);
    assert.equal(challengedHealth.status, 200);
    const challengedBody = (await challengedHealth.json()) as {
      status: "ok";
      protocol?: unknown;
      proof?: unknown;
    };
    assert.equal(
      challengedBody.protocol,
      DAEMON_HEALTH_PROTOCOL,
    );
    assert.equal(
      validDaemonHealthProof(
        challengedBody.proof,
        bearerToken,
        challenge,
        challengedBody.status,
      ),
      true,
    );

    const unauthorized = await fetch(running.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    });
    assert.equal(unauthorized.status, 401);

    const pathologicalAuthorization = await fetch(running.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${" ".repeat(4_000)}wrong`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
      signal: AbortSignal.timeout(2_000),
    });
    assert.equal(pathologicalAuthorization.status, 401);

    const foreignOrigin = await fetch(running.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "content-type": "application/json",
        Origin: "https://example.com",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    });
    assert.equal(foreignOrigin.status, 403);

    await Promise.all([
      first.client.connect(first.transport),
      second.client.connect(second.transport),
    ]);
    assert.equal(running.sessionCount, 2);

    const toolLists = await Promise.all([
      first.client.listTools(),
      second.client.listTools(),
    ]);
    for (const toolList of toolLists) {
      assert.deepEqual(
        toolList.tools.map((tool) => tool.name).sort(),
        [
          "get_asset",
          "get_conversation",
          "list_conversations",
          "search_conversations",
        ],
      );
    }

    await Promise.all([
      first.client.callTool({
        name: "list_conversations",
        arguments: { limit: 1 },
      }),
      second.client.callTool({
        name: "list_conversations",
        arguments: { limit: 1 },
      }),
    ]);
    assert.equal(backendRequests, 2);

    await first.transport.terminateSession();
    await first.client.close();
    assert.equal(running.sessionCount, 1);

    await second.client.callTool({
      name: "list_conversations",
      arguments: { limit: 1 },
    });
    assert.equal(backendRequests, 3);

    await second.transport.terminateSession();
    await second.client.close();
    assert.equal(running.sessionCount, 0);

    const abandoned = createClient(running.url, "abandoned-client");
    await abandoned.client.connect(abandoned.transport);
    assert.equal(running.sessionCount, 1);
    await abandoned.client.close();
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(running.sessionCount, 0);

    const shutdownUrl = new URL("/shutdown", running.url);
    const unauthorizedShutdown = await fetch(shutdownUrl, {
      method: "POST",
    });
    assert.equal(unauthorizedShutdown.status, 401);
    const shutdown = await fetch(shutdownUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
      },
    });
    assert.equal(shutdown.status, 202);
    await running.idle;
  } finally {
    await Promise.allSettled([
      first.client.close(),
      second.transport.terminateSession(),
    ]);
    await second.client.close().catch(() => undefined);
    await running.close();
    await new Promise<void>((resolve, reject) =>
      backend.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
