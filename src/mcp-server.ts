/**
 * Read My ChatGPT — MCP tool surface (live, read-only)
 *
 * Tools:
 *   list_conversations
 *   get_conversation
 *   get_asset
 *   search_conversations  (title-only)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ChatGPTApiError,
  ChatGPTAuthError,
  ChatGPTChallengeError,
  ChatGPTClient,
  ChatGPTTimeoutError,
  type ConversationListItem,
  type ConversationListResponse,
  type ConversationTimestamp,
} from "./chatgpt-client.js";
import { ConfigError, type Config } from "./config.js";
import {
  inferConversationExperience,
  type ConversationExperience,
} from "./conversation-experience.js";
import {
  ConversationAssetError,
  readConversationAsset,
  type DownloadedConversationAsset,
} from "./conversation-assets.js";
import { SERVICE_NAME } from "./install-paths.js";
import { activeBranchTranscript } from "./transcript.js";
import {
  getAssetToolDefinition,
  getConversationToolDefinition,
  listConversationsToolDefinition,
  readMyChatGptInstructions,
  searchConversationsToolDefinition,
} from "./tool-definitions.js";
import { formatTimestamp } from "./timestamp.js";
import { PACKAGE_VERSION } from "./version.js";

function jsonResult(data: unknown, isError = false) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
    isError,
  };
}

function errorResult(err: unknown) {
  if (err instanceof ConfigError) {
    return jsonResult({ error: err.code, message: err.message }, true);
  }
  if (err instanceof ChatGPTAuthError) {
    return jsonResult({ error: err.code, message: err.message }, true);
  }
  if (err instanceof ChatGPTChallengeError) {
    return jsonResult({ error: err.code, message: err.message }, true);
  }
  if (err instanceof ChatGPTTimeoutError) {
    return jsonResult({ error: err.code, message: err.message }, true);
  }
  if (err instanceof ChatGPTApiError) {
    return jsonResult(
      { error: err.code, message: err.message, status: err.status ?? null },
      true,
    );
  }
  if (err instanceof ConversationAssetError) {
    return jsonResult({ error: err.code, message: err.message }, true);
  }
  const message = err instanceof Error ? err.message : String(err);
  return jsonResult({ error: "internal_error", message }, true);
}

function assetResult(
  conversationId: string,
  asset: DownloadedConversationAsset,
): CallToolResult {
  const { body, ...metadata } = asset;
  const data = Buffer.from(body).toString("base64");
  const summary = {
    conversation_id: conversationId,
    asset: metadata,
    delivery: asset.kind === "image" ? "image" : "embedded_resource",
  };
  if (asset.kind === "image") {
    return {
      content: [
        { type: "text", text: JSON.stringify(summary, null, 2) },
        { type: "image", data, mimeType: asset.mime_type },
      ],
    };
  }
  return {
    content: [
      { type: "text", text: JSON.stringify(summary, null, 2) },
      {
        type: "resource",
        resource: {
          uri:
            `read-my-chatgpt://conversation/${encodeURIComponent(conversationId)}` +
            `/asset/${encodeURIComponent(asset.asset_id)}`,
          mimeType: asset.mime_type,
          blob: data,
        },
      },
    ],
  };
}

function normalizeItem(item: ConversationListItem, timeZone: string) {
  return {
    id: item.id,
    title: item.title?.trim() || "(untitled)",
    created_at: formatTimestamp(item.create_time ?? null, timeZone),
    updated_at: formatTimestamp(item.update_time ?? null, timeZone),
    create_time: item.create_time ?? null,
    update_time: item.update_time ?? null,
    is_archived: Boolean(item.is_archived),
    experience: inferConversationExperience(item),
    async_status: item.async_status ?? null,
  };
}

function hasMoreConversations(
  data: ConversationListResponse,
  requestedOffset: number,
  itemCount: number,
  requestedLimit: number,
): boolean {
  if (
    typeof data.total === "number" &&
    Number.isFinite(data.total) &&
    data.total >= 0
  ) {
    const responseOffset =
      typeof data.offset === "number" &&
      Number.isFinite(data.offset) &&
      data.offset >= 0
        ? data.offset
        : requestedOffset;
    return responseOffset + itemCount < data.total;
  }

  // Some Web API variants omit total; retain a conservative fallback.
  return itemCount >= requestedLimit;
}

type SearchHit = {
  conversation_id: string;
  title: string;
  updated_at: string | null;
  update_time: ConversationTimestamp;
  is_archived: boolean;
  experience: ConversationExperience;
  async_status: string | null;
};

type SearchScope = {
  isArchived: boolean;
  offset: number;
  done: boolean;
  hits: SearchHit[];
};

function sortableUpdateTime(hit: SearchHit): number {
  if (typeof hit.update_time === "number" && Number.isFinite(hit.update_time)) {
    return hit.update_time > 1e12
      ? hit.update_time
      : hit.update_time * 1000;
  }
  if (typeof hit.update_time === "string") {
    const parsed = Date.parse(hit.update_time);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NEGATIVE_INFINITY;
}

export function createReadMyChatGptMcpServer(
  config: Config,
  client: ChatGPTClient,
): McpServer {
  const server = new McpServer(
    {
      name: SERVICE_NAME,
      version: PACKAGE_VERSION,
    },
    {
      instructions: readMyChatGptInstructions(
        config.outputTimezone,
      ),
    },
  );

  server.registerTool(
    "list_conversations",
    listConversationsToolDefinition(config.outputTimezone),
    async ({ offset, limit, include_archived }) => {
      try {
        const pageLimit = Math.min(
          limit ?? config.defaultPageSize,
          config.maxPageSize,
        );
        const pageOffset = offset ?? 0;
        const data = await client.listConversations({
          offset: pageOffset,
          limit: pageLimit,
          order: "updated",
          isArchived: include_archived === true ? true : false,
        });
        const items = (data.items ?? []).map((item) =>
          normalizeItem(item, config.outputTimezone),
        );
        return jsonResult({
          time_zone: config.outputTimezone,
          items,
          offset: pageOffset,
          limit: pageLimit,
          count: items.length,
          has_more: hasMoreConversations(
            data,
            pageOffset,
            items.length,
            pageLimit,
          ),
          source: { kind: "live", host: config.baseUrl },
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_conversation",
    getConversationToolDefinition(config.outputTimezone),
    async ({ conversation_id, max_messages }) => {
      try {
        const detail = await client.getConversation(conversation_id);
        const transcript = activeBranchTranscript(detail, {
          maxMessages: max_messages ?? config.defaultMaxMessages,
          timeZone: config.outputTimezone,
        });
        return jsonResult({
          ...transcript,
          source: { kind: "live", host: config.baseUrl },
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_asset",
    getAssetToolDefinition(),
    async ({ conversation_id, asset_id }) => {
      try {
        const asset = await readConversationAsset(
          client,
          conversation_id,
          asset_id,
          config.maxAssetBytes,
        );
        return assetResult(conversation_id, asset);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "search_conversations",
    searchConversationsToolDefinition(config.outputTimezone),
    async ({ query, limit, include_archived }) => {
      try {
        const hitLimit = limit ?? 10;
        const needle = query.trim().toLowerCase();
        if (!needle) {
          return jsonResult(
            { error: "invalid_argument", message: "query must not be empty" },
            true,
          );
        }

        const pageSize = config.defaultPageSize;
        let scanned = 0;
        const scopes: SearchScope[] = [
          { isArchived: false, offset: 0, done: false, hits: [] },
        ];
        if (include_archived === true) {
          scopes.push({
            isArchived: true,
            offset: 0,
            done: false,
            hits: [],
          });
        }

        // Alternate pages between active and archived scopes. Each scope only
        // needs its first hitLimit matches; later matches cannot enter the
        // globally newest hitLimit results because the API is ordered by update.
        while (
          scanned < config.searchMaxScan &&
          scopes.some((scope) => !scope.done)
        ) {
          let madeRequest = false;

          for (const scope of scopes) {
            if (scope.done || scanned >= config.searchMaxScan) continue;
            madeRequest = true;

            const requestLimit = Math.min(
              pageSize,
              config.searchMaxScan - scanned,
            );
            const requestedOffset = scope.offset;
            const data = await client.listConversations({
              offset: requestedOffset,
              limit: requestLimit,
              order: "updated",
              isArchived: scope.isArchived,
            });
            const items = data.items ?? [];
            if (items.length === 0) {
              scope.done = true;
              continue;
            }

            for (const item of items) {
              if (scanned >= config.searchMaxScan) break;
              scanned += 1;
              const title = item.title?.trim() || "(untitled)";
              if (!title.toLowerCase().includes(needle)) continue;

              scope.hits.push({
                conversation_id: item.id,
                title,
                updated_at: formatTimestamp(
                  item.update_time ?? null,
                  config.outputTimezone,
                ),
                update_time: item.update_time ?? null,
                is_archived: item.is_archived ?? scope.isArchived,
                experience: inferConversationExperience(item),
                async_status: item.async_status ?? null,
              });
              if (scope.hits.length >= hitLimit) {
                scope.done = true;
                break;
              }
            }

            if (scope.done || scanned >= config.searchMaxScan) continue;
            if (
              !hasMoreConversations(
                data,
                requestedOffset,
                items.length,
                requestLimit,
              )
            ) {
              scope.done = true;
              continue;
            }

            const responseOffset =
              typeof data.offset === "number" &&
              Number.isFinite(data.offset) &&
              data.offset >= 0
                ? data.offset
                : requestedOffset;
            scope.offset = responseOffset + requestLimit;
          }

          if (!madeRequest) break;
        }

        const hits = scopes
          .flatMap((scope) => scope.hits)
          .sort((left, right) => {
            const leftTime = sortableUpdateTime(left);
            const rightTime = sortableUpdateTime(right);
            if (leftTime === rightTime) return 0;
            return rightTime > leftTime ? 1 : -1;
          })
          .slice(0, hitLimit);

        return jsonResult({
          query,
          time_zone: config.outputTimezone,
          hits,
          scanned,
          scan_cap: config.searchMaxScan,
          scope: "titles",
          source: { kind: "live", host: config.baseUrl },
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}
