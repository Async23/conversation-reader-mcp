import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { ChatGPTClient } from "../src/chatgpt-client.js";
import { ObscuraChatGPTTransport } from "../src/transport/obscura-transport.js";

type CdpCommand = {
  id: number;
  method: string;
  params?: { expression?: string; timeout?: number };
};

test("Obscura transport uses authenticated XHR instead of fetch", async (t) => {
  let browserWebSocketUrl = "";
  const requestExpressions: string[] = [];
  const requestTimeouts: Array<number | undefined> = [];
  const chunkExpressions: string[] = [];
  let stagedBody = "";
  const backendBody =
    `${JSON.stringify({ items: [] })}${" ".repeat(150_000)}`;
  const binaryBody = Buffer.from([137, 80, 78, 71]);
  const httpServer = http.createServer((request, response) => {
    assert.equal(request.url, "/json/version");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ webSocketDebuggerUrl: browserWebSocketUrl }));
  });
  const webSocketServer = new WebSocketServer({ server: httpServer });

  webSocketServer.on("connection", (socket) => {
    socket.on("message", (data) => {
      const command = JSON.parse(data.toString()) as CdpCommand;
      let result: object;

      switch (command.method) {
        case "Target.createTarget":
          result = { targetId: "page-1" };
          break;
        case "Target.attachToTarget":
          result = { sessionId: "session-1" };
          break;
        case "Page.enable":
        case "Page.navigate":
        case "Target.closeTarget":
          result = {};
          break;
        case "Runtime.evaluate": {
          const expression = command.params?.expression ?? "";
          let value: string;
          if (expression.includes("new XMLHttpRequest")) {
            requestExpressions.push(expression);
            requestTimeouts.push(command.params?.timeout);
            if (expression.includes("timeout-case")) return;
            if (expression.includes('responseType="blob"')) {
              stagedBody = binaryBody.toString("base64");
              value = JSON.stringify({
                status: 200,
                headers: { "content-type": "image/png" },
                bodyLength: stagedBody.length,
                // Transfer/blob size may differ from decoded bytes when the
                // upstream response has content encoding.
                byteLength: binaryBody.byteLength - 1,
              });
            } else {
              stagedBody = backendBody;
              value = JSON.stringify({
                status: expression.includes("secret-token") ? 200 : 401,
                headers: { "content-type": "application/json" },
                bodyLength: stagedBody.length,
              });
            }
          } else if (expression.includes(".textContent||\"\").slice(")) {
            chunkExpressions.push(expression);
            const match = expression.match(
              /\.slice\((\d+),(\d+)\)$/,
            );
            assert.ok(match);
            value = stagedBody.slice(Number(match[1]), Number(match[2]));
          } else if (expression.includes("element.remove()")) {
            result = { result: { type: "boolean", value: true } };
            break;
          } else {
            value = JSON.stringify({
              title: "ChatGPT",
              challenge: false,
            });
          }
          result = { result: { type: "string", value } };
          break;
        }
        default:
          throw new Error(`Unexpected CDP method: ${command.method}`);
      }

      socket.send(JSON.stringify({ id: command.id, result }));
    });
  });

  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const address = httpServer.address();
  assert.ok(address && typeof address === "object");
  browserWebSocketUrl = `ws://127.0.0.1:${address.port}/devtools/browser`;

  t.after(async () => {
    for (const client of webSocketServer.clients) client.terminate();
    await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
    await new Promise<void>((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  });

  const transport = await ObscuraChatGPTTransport.connect({
    accessToken: "secret-token",
    baseUrl: "https://chatgpt.com",
    cdpUrl: `http://127.0.0.1:${address.port}`,
    requestTimeoutMs: 25,
  });
  t.after(() => transport.close());

  const response = await transport.get(
    "/backend-api/conversations?offset=0&limit=1",
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(response.body), { items: [] });
  assert.equal(response.body.length, backendBody.length);
  assert.ok(chunkExpressions.length >= 3);

  const requestExpression = requestExpressions.at(-1) ?? "";
  assert.match(requestExpression, /new XMLHttpRequest/);
  assert.match(requestExpression, /xhr\.open\("GET"/);
  assert.match(requestExpression, /xhr\.withCredentials=true/);
  assert.match(requestExpression, /Authorization/);
  assert.match(requestExpression, /xhr\.timeout=25/);
  assert.doesNotMatch(requestExpression, /\bfetch\(/);
  assert.equal(requestTimeouts.at(-1), 25);

  const binary = await transport.getBinary(
    "https://files.example.com/signed/image?token=private",
    64,
  );
  assert.deepEqual([...binary.body], [...binaryBody]);
  assert.equal(binary.headers["content-type"], "image/png");
  const binaryExpression = requestExpressions.at(-1) ?? "";
  assert.match(binaryExpression, /responseType=\"blob\"/);
  assert.match(binaryExpression, /xhr\.withCredentials=false/);
  assert.doesNotMatch(binaryExpression, /Authorization/);
  assert.equal(requestTimeouts.at(-1), 25);

  await assert.rejects(
    () =>
      transport.getBinary(
        "https://files.example.com/signed/image?token=private",
        2,
      ),
    /exceeds the 2 byte limit/,
  );

  const timeoutStarted = Date.now();
  await assert.rejects(
    () =>
      transport.get("/backend-api/conversation/timeout-case"),
    /Obscura CDP command timed out: Runtime\.evaluate/,
  );
  assert.ok(Date.now() - timeoutStarted < 2_000);
  const timeoutExpression = requestExpressions.at(-1) ?? "";
  assert.match(timeoutExpression, /new XMLHttpRequest/);
  assert.match(timeoutExpression, /xhr\.timeout=25/);
  assert.equal(requestTimeouts.at(-1), 25);

  await assert.rejects(
    () => transport.get("/backend-api/conversations/batch"),
    /not allowlisted/,
  );
});

test("Obscura transport rejects a discovered non-loopback WebSocket", async (t) => {
  const httpServer = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        webSocketDebuggerUrl: "ws://example.com/devtools/browser",
      }),
    );
  });
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const address = httpServer.address();
  assert.ok(address && typeof address === "object");
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      ),
  );

  await assert.rejects(
    () =>
      ObscuraChatGPTTransport.connect({
        accessToken: "secret-token",
        baseUrl: "https://chatgpt.com",
        cdpUrl: `http://127.0.0.1:${address.port}`,
        commandTimeoutMs: 100,
      }),
    /loopback/,
  );
});

test("Obscura transport owns and stops a launched sidecar", async (t) => {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "read-my-chatgpt-obscura-"),
  );
  const wrapperPath = join(temporaryDirectory, "obscura");
  const fixturePath = fileURLToPath(
    new URL("./fixtures/fake-obscura.mjs", import.meta.url),
  );
  const shellQuote = (value: string) =>
    `'${value.replaceAll("'", `'\\''`)}'`;
  writeFileSync(
    wrapperPath,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fixturePath)} "$@"\n`,
  );
  chmodSync(wrapperPath, 0o700);
  t.after(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

  const transport = await ObscuraChatGPTTransport.launch({
    accessToken: "secret-token",
    baseUrl: "https://chatgpt.com",
    binaryPath: wrapperPath,
    startupTimeoutMs: 5_000,
  });

  const response = await transport.get(
    "/backend-api/conversations?offset=0&limit=1",
  );
  assert.equal(response.status, 200);

  await transport.close();
});

test("owned Obscura restarts after a wedged detail request", async (t) => {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "read-my-chatgpt-obscura-restart-"),
  );
  const storageDirectory = join(temporaryDirectory, "storage");
  mkdirSync(storageDirectory);
  const wrapperPath = join(temporaryDirectory, "obscura");
  const fixturePath = fileURLToPath(
    new URL("./fixtures/fake-obscura.mjs", import.meta.url),
  );
  const shellQuote = (value: string) =>
    `'${value.replaceAll("'", `'\\''`)}'`;
  writeFileSync(
    wrapperPath,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fixturePath)} "$@"\n`,
  );
  chmodSync(wrapperPath, 0o700);
  t.after(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

  const transport = await ObscuraChatGPTTransport.launch({
    accessToken: "secret-token",
    baseUrl: "https://chatgpt.com",
    binaryPath: wrapperPath,
    storageDir: storageDirectory,
    startupTimeoutMs: 2_000,
    commandTimeoutMs: 2_000,
    requestTimeoutMs: 50,
  });
  t.after(() => transport.close());
  const client = new ChatGPTClient(transport);
  const started = Date.now();

  const detail = await client.getConversation("restart-me");

  assert.equal(detail.conversation_id, "restart-me");
  assert.ok(Date.now() - started < 2_000);
});
