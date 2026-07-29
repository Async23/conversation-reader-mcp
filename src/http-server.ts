import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";
import { SERVICE_NAME } from "./install-paths.js";
import type { ReadMyChatGptRuntime } from "./runtime.js";
import type { RunningMcpServer } from "./stdio-server.js";

type HttpServerOptions = {
  host: string;
  port: number;
  bearerToken?: string;
  sessionIdleMs?: number;
  toolIdleMs?: number;
};

type Session = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastUsedAt: number;
  closePromise?: Promise<void>;
};

export type RunningHttpMcpServer = RunningMcpServer & {
  readonly host: string;
  readonly port: number;
  readonly url: URL;
  readonly sessionCount: number;
  readonly idle: Promise<void>;
};

export async function startHttpMcpServer(
  runtime: ReadMyChatGptRuntime,
  options: HttpServerOptions,
): Promise<RunningHttpMcpServer> {
  assertLoopbackHost(options.host);

  const app = createMcpExpressApp({ host: options.host });
  const sessions = new Map<string, Session>();
  const sessionIdleMs = options.sessionIdleMs ?? 30 * 60_000;
  let actualPort = options.port;
  let closing = false;
  let inFlightToolCalls = 0;
  let toolIdleTimer: NodeJS.Timeout | undefined;
  let shutdownRequested = false;
  let idleTriggered = false;
  let resolveIdle!: () => void;
  const idle = new Promise<void>((resolve) => {
    resolveIdle = resolve;
  });

  app.get("/healthz", (_request, response) => {
    response.json({
      status:
        closing || shutdownRequested ? "stopping" : "ok",
      server: SERVICE_NAME,
      transport: "streamable-http",
      sessions: sessions.size,
    });
  });

  if (options.toolIdleMs !== undefined) {
    app.post(
      "/shutdown",
      (request: Request, response: Response) => {
        if (!originAllowed(request.headers.origin, actualPort)) {
          response.status(403).json({
            error: "forbidden_origin",
          });
          return;
        }
        if (
          options.bearerToken &&
          !validBearerToken(
            request.headers.authorization,
            options.bearerToken,
          )
        ) {
          response.setHeader("WWW-Authenticate", "Bearer");
          response.status(401).json({
            error: "invalid_token",
          });
          return;
        }

        shutdownRequested = true;
        if (toolIdleTimer) {
          clearTimeout(toolIdleTimer);
          toolIdleTimer = undefined;
        }
        response.status(202).json({ status: "stopping" });
        if (inFlightToolCalls === 0) triggerIdle();
      },
    );
  }

  app.use(
    "/mcp",
    (request: Request, response: Response, next) => {
      if (closing || shutdownRequested) {
        response.status(503).json({
          error: "server_stopping",
        });
        return;
      }

      if (!originAllowed(request.headers.origin, actualPort)) {
        response.status(403).json({
          error: "forbidden_origin",
        });
        return;
      }

      if (
        options.bearerToken &&
        !validBearerToken(
          request.headers.authorization,
          options.bearerToken,
        )
      ) {
        response.setHeader("WWW-Authenticate", "Bearer");
        response.status(401).json({
          error: "invalid_token",
        });
        return;
      }

      next();
    },
  );

  app.post("/mcp", async (request: Request, response: Response) => {
    const tracksToolActivity = isToolCallRequest(request.body);
    if (tracksToolActivity) beginToolCall();
    try {
      const sessionId = singleHeader(request.headers["mcp-session-id"]);
      let session = sessionId ? sessions.get(sessionId) : undefined;

      if (!session && !sessionId && isInitializeRequest(request.body)) {
        let createdSession: Session;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (initializedSessionId) => {
            sessions.set(initializedSessionId, createdSession);
          },
        });
        const server = runtime.createMcpServer();
        createdSession = {
          server,
          transport,
          lastUsedAt: Date.now(),
        };
        transport.onclose = () => {
          const closedSessionId = transport.sessionId;
          if (
            closedSessionId &&
            sessions.get(closedSessionId) === createdSession
          ) {
            sessions.delete(closedSessionId);
          }
        };

        try {
          await server.connect(transport);
          await transport.handleRequest(request, response, request.body);
        } catch (error) {
          await server.close().catch(() => undefined);
          respondInternalError(response, error);
        }
        return;
      }

      if (!session) {
        respondMcpError(
          response,
          sessionId ? 404 : 400,
          -32_000,
          sessionId
            ? "Unknown MCP session"
            : "Missing MCP session ID or initialize request",
        );
        return;
      }

      session.lastUsedAt = Date.now();
      await session.transport.handleRequest(
        request,
        response,
        request.body,
      );
    } catch (error) {
      respondInternalError(response, error);
    } finally {
      if (tracksToolActivity) finishToolCall();
    }
  });

  const existingSessionHandler = async (
    request: Request,
    response: Response,
  ) => {
    const sessionId = singleHeader(request.headers["mcp-session-id"]);
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      respondMcpError(
        response,
        sessionId ? 404 : 400,
        -32_000,
        sessionId ? "Unknown MCP session" : "Missing MCP session ID",
      );
      return;
    }

    session.lastUsedAt = Date.now();
    try {
      await session.transport.handleRequest(request, response);
    } catch (error) {
      respondInternalError(response, error);
    }
  };

  app.get("/mcp", existingSessionHandler);
  app.delete("/mcp", existingSessionHandler);

  const cleanupIntervalMs = Math.max(
    250,
    Math.min(Math.floor(sessionIdleMs / 2), 60_000),
  );
  const cleanupTimer = setInterval(() => {
    const expirationTime = Date.now() - sessionIdleMs;
    for (const [sessionId, session] of sessions) {
      if (session.lastUsedAt <= expirationTime) {
        void closeSession(sessionId, session).catch((error) => {
          console.error(
            `[${SERVICE_NAME}] failed to close idle session ${sessionId}:`,
            error,
          );
        });
      }
    }
  }, cleanupIntervalMs);
  cleanupTimer.unref();

  const httpServer = await listen(app, options.port, options.host);
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    await closeHttpServer(httpServer);
    await runtime.close();
    throw new Error("HTTP server did not expose a TCP address");
  }
  actualPort = address.port;
  if (options.toolIdleMs !== undefined) {
    scheduleToolIdle();
  }

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closePromise) {
      closing = true;
      closePromise = (async () => {
        clearInterval(cleanupTimer);
        if (toolIdleTimer) clearTimeout(toolIdleTimer);
        const activeSessions = [...sessions.values()];
        sessions.clear();
        await Promise.allSettled(
          activeSessions.map((sessionEntry) =>
            sessionEntry.server.close(),
          ),
        );
        await closeHttpServer(httpServer);
        await runtime.close();
      })();
    }
    return closePromise;
  };

  const url = new URL(
    `http://${formatHost(options.host)}:${actualPort}/mcp`,
  );
  return {
    host: options.host,
    port: actualPort,
    url,
    get sessionCount() {
      return sessions.size;
    },
    idle,
    close,
  };

  function closeSession(
    sessionId: string,
    session: Session,
  ): Promise<void> {
    if (sessions.get(sessionId) === session) {
      sessions.delete(sessionId);
    }
    if (!session.closePromise) {
      session.closePromise = Promise.resolve().then(() =>
        session.server.close(),
      );
    }
    return session.closePromise;
  }

  function beginToolCall(): void {
    inFlightToolCalls += 1;
    if (toolIdleTimer) {
      clearTimeout(toolIdleTimer);
      toolIdleTimer = undefined;
    }
  }

  function finishToolCall(): void {
    inFlightToolCalls = Math.max(0, inFlightToolCalls - 1);
    if (inFlightToolCalls > 0 || closing) {
      return;
    }
    if (shutdownRequested) {
      triggerIdle();
      return;
    }
    if (options.toolIdleMs === undefined) return;
    scheduleToolIdle();
  }

  function scheduleToolIdle(): void {
    if (
      closing ||
      shutdownRequested ||
      idleTriggered ||
      options.toolIdleMs === undefined
    ) {
      return;
    }
    if (toolIdleTimer) clearTimeout(toolIdleTimer);
    toolIdleTimer = setTimeout(() => {
      toolIdleTimer = undefined;
      triggerIdle();
    }, options.toolIdleMs);
    toolIdleTimer.unref();
  }

  function triggerIdle(): void {
    if (idleTriggered) return;
    idleTriggered = true;
    shutdownRequested = true;
    resolveIdle();
  }
}

function listen(
  app: ReturnType<typeof createMcpExpressApp>,
  port: number,
  host: string,
): Promise<HttpServer> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    server.once("listening", () => {
      server.off("error", reject);
      resolve(server);
    });
    server.once("error", reject);
  });
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function singleHeader(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isToolCallRequest(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.some(isToolCallRequest);
  }
  return (
    typeof body === "object" &&
    body !== null &&
    "method" in body &&
    body.method === "tools/call"
  );
}

function respondMcpError(
  response: Response,
  status: number,
  code: number,
  message: string,
): void {
  if (response.headersSent) return;
  response.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function respondInternalError(
  response: Response,
  error: unknown,
): void {
  console.error(
    `[${SERVICE_NAME}] MCP HTTP request failed:`,
    error,
  );
  respondMcpError(
    response,
    500,
    -32_603,
    "Internal server error",
  );
}

function validBearerToken(
  authorization: string | undefined,
  expected: string,
): boolean {
  if (
    !authorization ||
    authorization.length <= 7 ||
    authorization.slice(0, 6).toLowerCase() !== "bearer" ||
    authorization.charCodeAt(6) !== 0x20
  ) {
    return false;
  }

  let tokenStart = 7;
  while (authorization.charCodeAt(tokenStart) === 0x20) {
    tokenStart += 1;
  }
  if (tokenStart === authorization.length) return false;

  const actualBytes = Buffer.from(
    authorization.slice(tokenStart),
    "utf8",
  );
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function originAllowed(
  origin: string | undefined,
  port: number,
): boolean {
  if (!origin) return true;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  return (
    url.protocol === "http:" &&
    isLoopbackHost(url.hostname) &&
    effectivePort(url) === port
  );
}

function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function assertLoopbackHost(host: string): void {
  if (!isLoopbackHost(host)) {
    throw new Error("MCP HTTP server must bind to a loopback host");
  }
}

function isLoopbackHost(host: string): boolean {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(
    host.toLowerCase(),
  );
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}
