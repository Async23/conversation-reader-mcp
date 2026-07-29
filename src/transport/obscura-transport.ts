import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import WebSocket from "ws";
import type {
  BinaryTransportResponse,
  ChatGPTTransport,
  TransportResponse,
} from "./chatgpt-transport.js";
import { assertAllowedAssetUrl } from "./asset-url.js";

type CdpMessage = {
  id?: number;
  result?: unknown;
  error?: { message?: string };
};

type PendingCommand = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type EvaluateResult = {
  result?: {
    type?: string;
    value?: unknown;
    description?: string;
  };
  exceptionDetails?: unknown;
};

export type ObscuraConnectOptions = {
  accessToken: string;
  baseUrl: string;
  cdpUrl: string;
  commandTimeoutMs?: number;
  requestTimeoutMs?: number;
};

export type ObscuraLaunchOptions = {
  accessToken: string;
  baseUrl: string;
  binaryPath: string;
  storageDir?: string;
  timezone?: string;
  startupTimeoutMs?: number;
  commandTimeoutMs?: number;
  requestTimeoutMs?: number;
};

class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  private closed = false;

  private constructor(
    private readonly socket: WebSocket,
    private readonly commandTimeoutMs: number,
  ) {
    socket.on("message", (data) => this.onMessage(data.toString()));
    socket.on("close", () =>
      this.rejectPending(new Error("Obscura CDP connection closed")),
    );
    socket.on("error", (error) => this.rejectPending(error));
  }

  static async connect(
    browserWebSocketUrl: string,
    commandTimeoutMs: number,
  ): Promise<CdpConnection> {
    const socket = new WebSocket(browserWebSocketUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error("Timed out connecting to Obscura CDP"));
      }, commandTimeoutMs);

      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return new CdpConnection(socket, commandTimeoutMs);
  }

  send<T>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = this.commandTimeoutMs,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("Obscura CDP connection is closed"));
    }

    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Obscura CDP command timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      const message: Record<string, unknown> = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      this.socket.send(JSON.stringify(message), (error) => {
        if (!error) return;
        const command = this.pending.get(id);
        if (!command) return;
        this.pending.delete(id);
        clearTimeout(command.timer);
        command.reject(error);
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(new Error("Obscura CDP connection closed"));

    if (
      this.socket.readyState === WebSocket.CLOSED ||
      this.socket.readyState === WebSocket.CLOSING
    ) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.socket.terminate();
        resolve();
      }, 1_000);
      this.socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.close();
    });
  }

  private onMessage(raw: string): void {
    let message: CdpMessage;
    try {
      message = JSON.parse(raw) as CdpMessage;
    } catch {
      return;
    }
    if (message.id === undefined) return;

    const command = this.pending.get(message.id);
    if (!command) return;
    this.pending.delete(message.id);
    clearTimeout(command.timer);

    if (message.error) {
      command.reject(
        new Error(message.error.message || "Obscura CDP command failed"),
      );
      return;
    }
    command.resolve(message.result ?? {});
  }

  private rejectPending(error: Error): void {
    for (const command of this.pending.values()) {
      clearTimeout(command.timer);
      command.reject(error);
    }
    this.pending.clear();
  }
}

async function resolveBrowserWebSocketUrl(
  cdpUrl: string,
  timeoutMs: number,
): Promise<string> {
  const endpoint = assertLoopbackUrl(cdpUrl, "Obscura CDP endpoint");
  if (endpoint.protocol === "ws:" || endpoint.protocol === "wss:") {
    return endpoint.toString();
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error(`Unsupported Obscura CDP URL protocol: ${endpoint.protocol}`);
  }

  const versionUrl = new URL("/json/version", endpoint);
  const response = await fetch(versionUrl, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      `Obscura CDP discovery returned HTTP ${response.status}`,
    );
  }
  const body = (await response.json()) as {
    webSocketDebuggerUrl?: unknown;
  };
  if (typeof body.webSocketDebuggerUrl !== "string") {
    throw new Error("Obscura CDP discovery omitted webSocketDebuggerUrl");
  }
  const browserEndpoint = assertLoopbackUrl(
    body.webSocketDebuggerUrl,
    "Discovered Obscura WebSocket",
  );
  if (
    browserEndpoint.protocol !== "ws:" &&
    browserEndpoint.protocol !== "wss:"
  ) {
    throw new Error(
      "Discovered Obscura WebSocket must use ws: or wss:",
    );
  }
  return browserEndpoint.toString();
}

function assertLoopbackUrl(value: string, label: string): URL {
  const endpoint = new URL(value);
  const loopbackHost = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    endpoint.hostname.toLowerCase(),
  );
  if (!loopbackHost) {
    throw new Error(`${label} must use a loopback host`);
  }
  return endpoint;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to reserve a loopback port for Obscura");
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function resolvedTimezone(): string {
  return (
    process.env.TZ ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    "UTC"
  );
}

async function waitForSidecar(
  cdpUrl: string,
  child: ChildProcess,
  startupTimeoutMs: number,
  getOutput: () => string,
  getSpawnError: () => Error | undefined,
): Promise<void> {
  const deadline = Date.now() + startupTimeoutMs;
  const versionUrl = new URL("/json/version", cdpUrl);

  while (Date.now() < deadline) {
    const spawnError = getSpawnError();
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) {
      const output = getOutput();
      throw new Error(
        `Obscura exited before CDP became ready${output ? `: ${output}` : ""}`,
      );
    }

    try {
      const response = await fetch(versionUrl, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      // Startup polling intentionally ignores connection refused/timeouts.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const output = getOutput();
  throw new Error(
    `Timed out waiting for Obscura CDP${output ? `: ${output}` : ""}`,
  );
}

async function stopSidecar(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");

  if (await waitForProcessExit(child, 2_000)) return;

  child.kill("SIGKILL");
  await waitForProcessExit(child, 2_000);
}

function waitForProcessExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

function evaluateValue(result: EvaluateResult, operation: string): string {
  if (result.exceptionDetails || typeof result.result?.value !== "string") {
    throw new Error(`Obscura failed to ${operation}`);
  }
  return result.result.value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type StoredResponseMetadata = {
  status: number;
  headers: Record<string, string>;
  bodyLength: number;
};

type StoredBinaryResponseMetadata = StoredResponseMetadata & {
  byteLength: number;
};

function isStoredResponseMetadata(
  value: unknown,
): value is StoredResponseMetadata {
  return (
    isRecord(value) &&
    typeof value.status === "number" &&
    isRecord(value.headers) &&
    typeof value.bodyLength === "number" &&
    Number.isSafeInteger(value.bodyLength) &&
    value.bodyLength >= 0 &&
    Object.values(value.headers).every(
      (header) => typeof header === "string",
    )
  );
}

function isStoredBinaryResponseMetadata(
  value: unknown,
): value is StoredBinaryResponseMetadata {
  if (!isStoredResponseMetadata(value)) return false;
  const byteLength = (
    value as StoredResponseMetadata & { byteLength?: unknown }
  ).byteLength;
  return (
    typeof byteLength === "number" &&
    Number.isSafeInteger(byteLength) &&
    byteLength >= 0
  );
}

const RESPONSE_CHUNK_CHARS = 64 * 1024;
const MAX_RESPONSE_BODY_CHARS = 64 * 1024 * 1024;

function assertAllowedBackendUrl(
  baseUrl: string,
  path: string,
): URL {
  const base = new URL(baseUrl);
  const url = new URL(path, base);
  if (url.origin !== base.origin) {
    throw new Error("Refusing to send ChatGPT credentials cross-origin");
  }
  const allowed =
    url.pathname === "/backend-api/conversations" ||
    url.pathname.startsWith("/backend-api/conversation/") ||
    url.pathname.startsWith("/backend-api/files/download/");
  if (!allowed) {
    throw new Error(`ChatGPT endpoint is not allowlisted: ${url.pathname}`);
  }
  return url;
}

function isRuntimeEvaluateTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message ===
      "Obscura CDP command timed out: Runtime.evaluate" ||
      (/Runtime\.evaluate/i.test(error.message) &&
        /\b(?:exceeded|timed out|timeout)\b/i.test(error.message)))
  );
}

export class ObscuraChatGPTTransport implements ChatGPTTransport {
  private closed = false;
  private queue: Promise<void> = Promise.resolve();
  private ownedProcess?: ChildProcess;
  private ownedLaunchOptions?: ObscuraLaunchOptions;
  private nextResponseSlot = 1;

  private constructor(
    private readonly accessToken: string,
    private readonly baseUrl: string,
    private cdp: CdpConnection,
    private targetId: string,
    private sessionId: string,
    private readonly requestTimeoutMs: number,
  ) {}

  static async connect(
    options: ObscuraConnectOptions,
  ): Promise<ObscuraChatGPTTransport> {
    const timeoutMs = options.commandTimeoutMs ?? 60_000;
    const browserWebSocketUrl = await resolveBrowserWebSocketUrl(
      options.cdpUrl,
      timeoutMs,
    );
    const cdp = await CdpConnection.connect(browserWebSocketUrl, timeoutMs);

    try {
      const target = await cdp.send<{ targetId?: string }>(
        "Target.createTarget",
        { url: "about:blank" },
      );
      if (!target.targetId) {
        throw new Error("Obscura did not create a browser target");
      }

      const attached = await cdp.send<{ sessionId?: string }>(
        "Target.attachToTarget",
        { targetId: target.targetId, flatten: true },
      );
      if (!attached.sessionId) {
        throw new Error("Obscura did not attach to the browser target");
      }

      const transport = new ObscuraChatGPTTransport(
        options.accessToken,
        options.baseUrl,
        cdp,
        target.targetId,
        attached.sessionId,
        options.requestTimeoutMs ?? 20_000,
      );
      await transport.bootstrap();
      return transport;
    } catch (error) {
      await cdp.close();
      throw error;
    }
  }

  static async launch(
    options: ObscuraLaunchOptions,
  ): Promise<ObscuraChatGPTTransport> {
    const transport = await ObscuraChatGPTTransport.launchOnce(options);
    transport.ownedLaunchOptions = { ...options };
    return transport;
  }

  private static async launchOnce(
    options: ObscuraLaunchOptions,
  ): Promise<ObscuraChatGPTTransport> {
    const port = await reserveLoopbackPort();
    const cdpUrl = `http://127.0.0.1:${port}`;
    const args = [
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--stealth",
      "--quiet",
    ];
    if (options.storageDir) {
      args.push("--storage-dir", options.storageDir);
    }

    const child = spawn(options.binaryPath, args, {
      env: {
        ...process.env,
        OBSCURA_TIMEZONE: options.timezone || resolvedTimezone(),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let spawnError: Error | undefined;
    const appendOutput = (chunk: Buffer | string) => {
      output = `${output}${chunk.toString()}`.slice(-4_000);
    };
    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);
    child.once("error", (error) => {
      spawnError = error;
    });

    try {
      await waitForSidecar(
        cdpUrl,
        child,
        options.startupTimeoutMs ?? 15_000,
        () => output.trim(),
        () => spawnError,
      );
      const transport = await ObscuraChatGPTTransport.connect({
        accessToken: options.accessToken,
        baseUrl: options.baseUrl,
        cdpUrl,
        commandTimeoutMs: options.commandTimeoutMs,
        requestTimeoutMs: options.requestTimeoutMs,
      });
      transport.ownedProcess = child;
      return transport;
    } catch (error) {
      await stopSidecar(child);
      throw error;
    }
  }

  get(path: string): Promise<TransportResponse> {
    return this.enqueue(() => this.performGet(path));
  }

  getBinary(
    url: string,
    maxBytes: number,
  ): Promise<BinaryTransportResponse> {
    return this.enqueue(() => this.performGetBinary(url, maxBytes));
  }

  private enqueue<T>(request: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("Obscura transport is closed"));
    }

    const result = this.queue.then(async () => {
      try {
        return await request();
      } catch (error) {
        if (
          this.ownedProcess &&
          this.ownedLaunchOptions &&
          isRuntimeEvaluateTimeout(error)
        ) {
          await this.restartOwnedSidecar();
        }
        throw error;
      }
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    try {
      await this.cdp.send("Target.closeTarget", {
        targetId: this.targetId,
      });
    } catch {
      // The target may already be gone if Obscura exited first.
    }
    await this.cdp.close();
    if (this.ownedProcess) {
      await stopSidecar(this.ownedProcess);
    }
  }

  private async restartOwnedSidecar(): Promise<void> {
    const options = this.ownedLaunchOptions;
    const child = this.ownedProcess;
    if (!options || !child) return;

    this.ownedProcess = undefined;
    await stopSidecar(child);
    await this.cdp.close();

    const replacement =
      await ObscuraChatGPTTransport.launchOnce(options);
    this.cdp = replacement.cdp;
    this.targetId = replacement.targetId;
    this.sessionId = replacement.sessionId;
    this.ownedProcess = replacement.ownedProcess;
    replacement.ownedProcess = undefined;
  }

  private async bootstrap(): Promise<void> {
    await this.cdp.send("Page.enable", {}, this.sessionId);
    await this.cdp.send(
      "Page.navigate",
      { url: new URL("/", this.baseUrl).toString(), waitUntil: "load" },
      this.sessionId,
    );

    const expression =
      "JSON.stringify((function(){" +
      "const title=String(document.title||\"\");" +
      "const body=String(document.body&&document.body.innerText||\"\").toLowerCase();" +
      "return {title:title,challenge:title.toLowerCase().includes(\"just a moment\")||body.includes(\"cf-chl\")||body.includes(\"challenge-platform\")};" +
      "})())";
    const evaluated = await this.cdp.send<EvaluateResult>(
      "Runtime.evaluate",
      { expression, returnByValue: true },
      this.sessionId,
    );
    const state = JSON.parse(
      evaluateValue(evaluated, "inspect the ChatGPT bootstrap page"),
    ) as { challenge?: boolean };
    if (state.challenge) {
      throw new Error(
        "Cloudflare challenged the Obscura bootstrap session",
      );
    }
  }

  private async performGet(path: string): Promise<TransportResponse> {
    const url = assertAllowedBackendUrl(this.baseUrl, path);
    const responseSlot =
      `__read_my_chatgpt_response_${this.nextResponseSlot++}`;
    const expression =
      "new Promise(function(resolve){" +
      "const xhr=new XMLHttpRequest();" +
      `xhr.open("GET",${JSON.stringify(url.toString())},true);` +
      "xhr.withCredentials=true;" +
      `xhr.setRequestHeader("Authorization","Bearer "+${JSON.stringify(this.accessToken)});` +
      'xhr.setRequestHeader("Accept","application/json");' +
      `xhr.timeout=${this.requestTimeoutMs};` +
      "xhr.onload=function(){try{" +
      'const responseBody=String(xhr.responseText||"");' +
      'const responseElement=document.createElement("pre");' +
      `responseElement.id=${JSON.stringify(responseSlot)};` +
      "responseElement.hidden=true;" +
      "responseElement.textContent=responseBody;" +
      "(document.body||document.documentElement).appendChild(responseElement);" +
      "resolve(JSON.stringify({" +
      "status:xhr.status," +
      'headers:{"content-type":xhr.getResponseHeader("content-type")||"",' +
      '"cf-mitigated":xhr.getResponseHeader("cf-mitigated")||"",' +
      '"server":xhr.getResponseHeader("server")||"",' +
      '"cf-ray":xhr.getResponseHeader("cf-ray")||""},' +
      "bodyLength:responseBody.length}));" +
      "}catch(error){resolve(JSON.stringify({transportError:{" +
      'name:"ResponseError",' +
      'message:String(error&&error.message||error||"invalid XHR response")' +
      "}}));}};" +
      "xhr.onerror=function(){resolve(JSON.stringify({transportError:{" +
      'name:"NetworkError",message:"Obscura XMLHttpRequest failed"}}));};' +
      "xhr.ontimeout=function(){resolve(JSON.stringify({transportError:{" +
      `name:"TimeoutError",message:"ChatGPT request timed out after ${this.requestTimeoutMs}ms"}}));};` +
      "xhr.onabort=function(){resolve(JSON.stringify({transportError:{" +
      'name:"AbortError",message:"Obscura XMLHttpRequest was aborted"}}));};' +
      "xhr.send();" +
      "})";
    const evaluated = await this.cdp.send<EvaluateResult>(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        timeout: this.requestTimeoutMs,
      },
      this.sessionId,
      this.requestTimeoutMs + 1_000,
    );
    const response: unknown = JSON.parse(
      evaluateValue(evaluated, "request the ChatGPT backend endpoint"),
    );

    try {
      const transportError =
        isRecord(response) && isRecord(response.transportError)
          ? response.transportError
          : null;
      if (transportError) {
        const name =
          typeof transportError.name === "string"
            ? transportError.name
            : "";
        const message =
          typeof transportError.message === "string"
            ? transportError.message
            : "";
        if (
          name === "AbortError" ||
          name === "TimeoutError" ||
          message.toLowerCase().includes("abort")
        ) {
          throw new Error(
            `ChatGPT request timed out after ${this.requestTimeoutMs}ms`,
          );
        }
        throw new Error(
          `Obscura XMLHttpRequest failed${name ? ` (${name})` : ""}: ${message}`,
        );
      }

      if (!isStoredResponseMetadata(response)) {
        throw new Error("Obscura returned invalid response metadata");
      }
      if (response.bodyLength > MAX_RESPONSE_BODY_CHARS) {
        throw new Error(
          `ChatGPT response exceeds ${MAX_RESPONSE_BODY_CHARS} characters`,
        );
      }

      let body = "";
      for (
        let offset = 0;
        offset < response.bodyLength;
        offset += RESPONSE_CHUNK_CHARS
      ) {
        const end = Math.min(
          offset + RESPONSE_CHUNK_CHARS,
          response.bodyLength,
        );
        const chunkResult = await this.cdp.send<EvaluateResult>(
          "Runtime.evaluate",
          {
            expression:
              `String((document.getElementById(${JSON.stringify(responseSlot)})||{}).textContent||"")` +
              `.slice(${offset},${end})`,
            returnByValue: true,
          },
          this.sessionId,
          5_000,
        );
        body += evaluateValue(
          chunkResult,
          "read a ChatGPT response chunk",
        );
      }

      if (body.length !== response.bodyLength) {
        throw new Error(
          `Obscura returned an incomplete backend response: expected ${response.bodyLength} characters, received ${body.length}`,
        );
      }

      return {
        status: response.status,
        headers: response.headers,
        body,
      };
    } finally {
      await this.cdp
        .send(
          "Runtime.evaluate",
          {
            expression:
              "(function(){" +
              `const element=document.getElementById(${JSON.stringify(responseSlot)});` +
              "if(element)element.remove();" +
              "return true;" +
              "})()",
            returnByValue: true,
          },
          this.sessionId,
          1_000,
        )
        .catch(() => undefined);
    }
  }

  private async performGetBinary(
    value: string,
    maxBytes: number,
  ): Promise<BinaryTransportResponse> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error("Asset byte limit must be a positive integer");
    }

    const url = assertAllowedAssetUrl(this.baseUrl, value);
    const sameOrigin = url.origin === new URL(this.baseUrl).origin;
    const responseSlot =
      `__read_my_chatgpt_response_${this.nextResponseSlot++}`;
    const setAuthorization = sameOrigin
      ? `xhr.setRequestHeader("Authorization","Bearer "+${JSON.stringify(this.accessToken)});`
      : "";
    const expression =
      "new Promise(function(resolve){" +
      "let settled=false;" +
      "const finish=function(value){if(settled)return false;settled=true;resolve(JSON.stringify(value));return true;};" +
      "const xhr=new XMLHttpRequest();" +
      `xhr.open("GET",${JSON.stringify(url.toString())},true);` +
      `xhr.withCredentials=${sameOrigin ? "true" : "false"};` +
      setAuthorization +
      'xhr.setRequestHeader("Accept","*/*");' +
      "xhr.responseType=\"blob\";" +
      `xhr.timeout=${this.requestTimeoutMs};` +
      "const tooLarge=function(size){if(finish({tooLarge:true,byteLength:size}))xhr.abort();};" +
      "xhr.onreadystatechange=function(){if(xhr.readyState!==2||settled)return;" +
      'const declared=Number(xhr.getResponseHeader("content-length"));' +
      `if(Number.isFinite(declared)&&declared>${maxBytes})tooLarge(declared);};` +
      `xhr.onprogress=function(event){if(!settled&&event.loaded>${maxBytes})tooLarge(event.loaded);};` +
      "xhr.onload=function(){if(settled)return;try{" +
      "const responseBlob=xhr.response;" +
      "const byteLength=Number(responseBlob&&responseBlob.size||0);" +
      `if(byteLength>${maxBytes}){tooLarge(byteLength);return;}` +
      "const reader=new FileReader();" +
      "reader.onload=function(){try{" +
      'const dataUrl=String(reader.result||"");' +
      'const comma=dataUrl.indexOf(",");' +
      'if(comma<0)throw new Error("invalid FileReader data URL");' +
      "const responseBody=dataUrl.slice(comma+1);" +
      'const responseElement=document.createElement("pre");' +
      `responseElement.id=${JSON.stringify(responseSlot)};` +
      "responseElement.hidden=true;" +
      "responseElement.textContent=responseBody;" +
      "(document.body||document.documentElement).appendChild(responseElement);" +
      "finish({" +
      "status:xhr.status," +
      'headers:{"content-type":xhr.getResponseHeader("content-type")||"",' +
      '"content-length":xhr.getResponseHeader("content-length")||"",' +
      '"content-disposition":xhr.getResponseHeader("content-disposition")||""},' +
      "bodyLength:responseBody.length,byteLength:byteLength});" +
      "}catch(error){finish({transportError:{" +
      'name:"ResponseError",' +
      'message:String(error&&error.message||error||"invalid FileReader response")' +
      "}});}};" +
      "reader.onerror=function(){finish({transportError:{" +
      'name:"ResponseError",message:"Obscura FileReader failed"}});};' +
      "reader.readAsDataURL(responseBlob);" +
      "}catch(error){finish({transportError:{" +
      'name:"ResponseError",' +
      'message:String(error&&error.message||error||"invalid XHR response")' +
      "}});}};" +
      "xhr.onerror=function(){finish({transportError:{" +
      'name:"NetworkError",message:"Obscura XMLHttpRequest failed"}});};' +
      "xhr.ontimeout=function(){finish({transportError:{" +
      `name:"TimeoutError",message:"ChatGPT asset request timed out after ${this.requestTimeoutMs}ms"}});};` +
      "xhr.onabort=function(){finish({transportError:{" +
      'name:"AbortError",message:"Obscura XMLHttpRequest was aborted"}});};' +
      "xhr.send();" +
      "})";

    const evaluated = await this.cdp.send<EvaluateResult>(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        timeout: this.requestTimeoutMs,
      },
      this.sessionId,
      this.requestTimeoutMs + 1_000,
    );
    const response: unknown = JSON.parse(
      evaluateValue(evaluated, "download a ChatGPT asset"),
    );

    try {
      if (isRecord(response) && response.tooLarge === true) {
        throw new Error(`Asset exceeds the ${maxBytes} byte limit`);
      }

      const transportError =
        isRecord(response) && isRecord(response.transportError)
          ? response.transportError
          : null;
      if (transportError) {
        const name =
          typeof transportError.name === "string"
            ? transportError.name
            : "NetworkError";
        if (name === "AbortError" || name === "TimeoutError") {
          throw new Error(
            `ChatGPT asset request timed out after ${this.requestTimeoutMs}ms`,
          );
        }
        throw new Error(`Asset download failed (${name})`);
      }

      if (!isStoredBinaryResponseMetadata(response)) {
        throw new Error("Obscura returned invalid asset response metadata");
      }
      const maxBase64Chars = Math.ceil(maxBytes / 3) * 4;
      if (
        response.byteLength > maxBytes ||
        response.bodyLength > maxBase64Chars ||
        response.bodyLength > MAX_RESPONSE_BODY_CHARS
      ) {
        throw new Error(`Asset exceeds the ${maxBytes} byte limit`);
      }

      let base64 = "";
      for (
        let offset = 0;
        offset < response.bodyLength;
        offset += RESPONSE_CHUNK_CHARS
      ) {
        const end = Math.min(
          offset + RESPONSE_CHUNK_CHARS,
          response.bodyLength,
        );
        const chunkResult = await this.cdp.send<EvaluateResult>(
          "Runtime.evaluate",
          {
            expression:
              `String((document.getElementById(${JSON.stringify(responseSlot)})||{}).textContent||"")` +
              `.slice(${offset},${end})`,
            returnByValue: true,
          },
          this.sessionId,
          5_000,
        );
        base64 += evaluateValue(
          chunkResult,
          "read a ChatGPT asset response chunk",
        );
      }

      if (base64.length !== response.bodyLength) {
        throw new Error("Obscura returned an incomplete asset response");
      }
      const body = Uint8Array.from(Buffer.from(base64, "base64"));
      if (body.byteLength > maxBytes) {
        throw new Error(`Asset exceeds the ${maxBytes} byte limit`);
      }
      return {
        status: response.status,
        headers: response.headers,
        body,
      };
    } finally {
      await this.cdp
        .send(
          "Runtime.evaluate",
          {
            expression:
              "(function(){" +
              `const element=document.getElementById(${JSON.stringify(responseSlot)});` +
              "if(element)element.remove();" +
              "return true;" +
              "})()",
            returnByValue: true,
          },
          this.sessionId,
          1_000,
        )
        .catch(() => undefined);
    }
  }
}
