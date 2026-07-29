import assert from "node:assert/strict";
import test from "node:test";
import { ConfigError, loadConfig } from "../src/config.js";

test("uses an owned Obscura sidecar by default", () => {
  const config = loadConfig({
    READ_MY_CHATGPT_ACCESS_TOKEN: "test-token",
  });

  assert.equal(config.transport, "obscura");
  assert.equal(config.mcpTransport, "stdio");
  assert.equal(config.mcpHost, "127.0.0.1");
  assert.equal(config.mcpPort, 47831);
  assert.equal(config.mcpSessionIdleMs, 1_800_000);
  assert.equal(config.daemonIdleMs, 600_000);
  assert.equal(config.obscuraBinary, undefined);
  assert.equal(config.obscuraCdpUrl, undefined);
  assert.equal(config.outputTimezone, "UTC");
  assert.equal(config.maxAssetBytes, 10 * 1024 * 1024);
});

test("loads and validates the output timezone", () => {
  assert.equal(
    loadConfig({
      READ_MY_CHATGPT_ACCESS_TOKEN: "test-token",
      READ_MY_CHATGPT_OUTPUT_TIMEZONE: "Asia/Shanghai",
    }).outputTimezone,
    "Asia/Shanghai",
  );

  assert.throws(
    () =>
      loadConfig({
        READ_MY_CHATGPT_ACCESS_TOKEN: "test-token",
        READ_MY_CHATGPT_OUTPUT_TIMEZONE: "Mars/Olympus_Mons",
      }),
    (error) =>
      error instanceof ConfigError &&
      error.message.includes("READ_MY_CHATGPT_OUTPUT_TIMEZONE"),
  );
});

test("rejects unknown ChatGPT transports", () => {
  assert.throws(
    () =>
      loadConfig({
        READ_MY_CHATGPT_ACCESS_TOKEN: "test-token",
        READ_MY_CHATGPT_TRANSPORT: "unknown",
      }),
    (error) =>
      error instanceof ConfigError && error.code === "config_error",
  );
});

test("rejects a non-loopback Obscura CDP endpoint", () => {
  assert.throws(
    () =>
      loadConfig({
        READ_MY_CHATGPT_ACCESS_TOKEN: "test-token",
        READ_MY_CHATGPT_OBSCURA_CDP_URL: "ws://example.com/devtools/browser",
      }),
    (error) =>
      error instanceof ConfigError &&
      error.message.includes("loopback"),
  );
});

test("loads a loopback HTTP MCP endpoint", () => {
  const config = loadConfig({
    READ_MY_CHATGPT_ACCESS_TOKEN: "test-token",
    READ_MY_CHATGPT_MCP_TRANSPORT: "http",
    READ_MY_CHATGPT_MCP_HOST: "localhost",
    READ_MY_CHATGPT_MCP_PORT: "43123",
    READ_MY_CHATGPT_MCP_BEARER_TOKEN: "mcp-secret",
  });

  assert.equal(config.mcpTransport, "http");
  assert.equal(config.mcpHost, "localhost");
  assert.equal(config.mcpPort, 43123);
  assert.equal(config.mcpBearerToken, "mcp-secret");
});

test("rejects a non-loopback HTTP MCP endpoint", () => {
  assert.throws(
    () =>
      loadConfig({
        READ_MY_CHATGPT_ACCESS_TOKEN: "test-token",
        READ_MY_CHATGPT_MCP_TRANSPORT: "http",
        READ_MY_CHATGPT_MCP_HOST: "0.0.0.0",
      }),
    (error) =>
      error instanceof ConfigError &&
      error.message.includes("loopback"),
  );
});

test("rejects an invalid HTTP MCP port", () => {
  assert.throws(
    () =>
      loadConfig({
        READ_MY_CHATGPT_ACCESS_TOKEN: "test-token",
        READ_MY_CHATGPT_MCP_PORT: "65536",
      }),
    (error) =>
      error instanceof ConfigError &&
      error.message.includes("1 to 65535"),
  );
});

test("rejects an unsafe HTTP MCP session idle timeout", () => {
  assert.throws(
    () =>
      loadConfig({
        READ_MY_CHATGPT_ACCESS_TOKEN: "test-token",
        READ_MY_CHATGPT_MCP_SESSION_IDLE_MS: "999",
      }),
    (error) =>
      error instanceof ConfigError &&
      error.message.includes("at least 1000"),
  );
});

test("loads and validates the on-demand daemon idle timeout", () => {
  assert.equal(
    loadConfig({
      READ_MY_CHATGPT_ACCESS_TOKEN: "test-token",
      READ_MY_CHATGPT_DAEMON_IDLE_MS: "120000",
    }).daemonIdleMs,
    120_000,
  );

  assert.throws(
    () =>
      loadConfig({
        READ_MY_CHATGPT_ACCESS_TOKEN: "test-token",
        READ_MY_CHATGPT_DAEMON_IDLE_MS: "99",
      }),
    (error) =>
      error instanceof ConfigError &&
      error.message.includes("READ_MY_CHATGPT_DAEMON_IDLE_MS"),
  );
});

test("loads and validates the asset byte limit", () => {
  assert.equal(
    loadConfig({
      READ_MY_CHATGPT_ACCESS_TOKEN: "test-token",
      READ_MY_CHATGPT_MAX_ASSET_BYTES: "2097152",
    }).maxAssetBytes,
    2 * 1024 * 1024,
  );

  assert.throws(
    () =>
      loadConfig({
        READ_MY_CHATGPT_ACCESS_TOKEN: "test-token",
        READ_MY_CHATGPT_MAX_ASSET_BYTES: "33554433",
      }),
    (error) =>
      error instanceof ConfigError &&
      error.message.includes("READ_MY_CHATGPT_MAX_ASSET_BYTES"),
  );
});
