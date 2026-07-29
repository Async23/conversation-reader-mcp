import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Config } from "./config.js";
import { OnDemandDaemonClient } from "./daemon-client.js";
import { SERVICE_NAME } from "./install-paths.js";
import type { RunningMcpServer } from "./stdio-server.js";
import {
  getAssetToolDefinition,
  getConversationToolDefinition,
  listConversationsToolDefinition,
  readMyChatGptInstructions,
  searchConversationsToolDefinition,
} from "./tool-definitions.js";
import { PACKAGE_VERSION } from "./version.js";

export async function startConnectorMcpServer(
  config: Config,
  configPath: string,
): Promise<RunningMcpServer> {
  const daemon = new OnDemandDaemonClient(config, configPath);
  const server = new McpServer(
    {
      name: SERVICE_NAME,
      version: PACKAGE_VERSION,
    },
    {
      instructions: readMyChatGptInstructions(
        config.outputTimezone,
        true,
      ),
    },
  );

  server.registerTool(
    "list_conversations",
    listConversationsToolDefinition(config.outputTimezone),
    (args, extra) =>
      daemon.callTool("list_conversations", args, extra.signal),
  );
  server.registerTool(
    "get_conversation",
    getConversationToolDefinition(config.outputTimezone),
    (args, extra) =>
      daemon.callTool("get_conversation", args, extra.signal),
  );
  server.registerTool(
    "get_asset",
    getAssetToolDefinition(),
    (args, extra) =>
      daemon.callTool("get_asset", args, extra.signal),
  );
  server.registerTool(
    "search_conversations",
    searchConversationsToolDefinition(config.outputTimezone),
    (args, extra) =>
      daemon.callTool("search_conversations", args, extra.signal),
  );

  const transport = new StdioServerTransport();
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closePromise) {
      closePromise = Promise.resolve().then(async () => {
        await Promise.allSettled([server.close(), daemon.close()]);
      });
    }
    return closePromise;
  };

  transport.onclose = () => {
    void close();
  };
  process.stdin.once("end", () => {
    void close();
  });

  await server.connect(transport);
  return { close };
}
