import { z } from "zod";

export function readMyChatGptInstructions(
  timeZone: string,
  onDemand = false,
): string {
  const base =
    "This server provides read-only access to conversations stored in the authenticated user's ChatGPT Web account at chatgpt.com. " +
    "Use these tools only when the requested data source is ChatGPT Web history. " +
    `Returned conversation timestamps are formatted in ${timeZone}. ` +
    "When reporting time to the user, prefer created_at and updated_at. " +
    "The create_time and update_time fields are unmodified upstream values kept for compatibility.";
  return onDemand
    ? `${base} The shared ChatGPT runtime starts only when a tool is called.`
    : base;
}

export function listConversationsToolDefinition(timeZone: string) {
  return {
    description:
      `List Chat and Work conversation metadata stored in the authenticated user's ChatGPT Web account at chatgpt.com (id, title, timestamps, experience). ` +
      "Use only for ChatGPT Web history, such as finding a recent ChatGPT Web conversation or obtaining a conversation_id. Does not return message bodies. " +
      `created_at and updated_at are RFC 3339 timestamps in ${timeZone}; prefer them when reporting time. ` +
      "create_time and update_time retain their upstream values for compatibility.",
    inputSchema: {
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Pagination offset (default 0)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Page size (default 28, max 50)"),
      include_archived: z
        .boolean()
        .optional()
        .describe(
          "If true, list archived conversations only; default false (non-archived)",
        ),
    },
  };
}

export function getConversationToolDefinition(timeZone: string) {
  return {
    description:
      `Fetch one completed Chat or Work conversation from the authenticated user's ChatGPT Web account at chatgpt.com and return the active branch only (the current visible user/assistant turn chain). ` +
      `created_at, updated_at, and messages[].created_at are RFC 3339 timestamps in ${timeZone}. ` +
      "Text remains in messages[].content; links, web citations, Mermaid source, and image/file asset ids appear in messages[].rich_content when present. Internal reasoning, hidden events, and tool execution are omitted. Use get_asset to read an indexed image or file.",
    inputSchema: {
      conversation_id: z
        .string()
        .min(1)
        .describe("ChatGPT Web conversation id from list/search"),
      max_messages: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe(
          "Max visible user/assistant messages to return (default 100). Longer threads are truncated with head+tail kept.",
        ),
    },
  };
}

export function getAssetToolDefinition() {
  return {
    description:
      "Fetch one image or file attachment from a conversation stored in the authenticated user's ChatGPT Web account at chatgpt.com. Use the conversation_id and asset_id returned by get_conversation in messages[].rich_content.assets. The asset must belong to the active visible branch; downloads are MIME-checked and size-limited.",
    inputSchema: {
      conversation_id: z
        .string()
        .min(1)
        .describe("ChatGPT Web conversation id used with get_conversation"),
      asset_id: z
        .string()
        .regex(/^asset_[A-Za-z0-9_-]{32}$/)
        .describe(
          "Opaque asset id from messages[].rich_content.assets[].asset_id",
        ),
    },
  };
}

export function searchConversationsToolDefinition(
  timeZone: string,
) {
  return {
    description:
      `Search Chat and Work conversation titles stored in the authenticated user's ChatGPT Web account at chatgpt.com (title-only MVP). ` +
      "Use only for ChatGPT Web history. " +
      `updated_at is an RFC 3339 timestamp in ${timeZone}; prefer it when reporting time. ` +
      "Returns matching conversation ids, titles, and experience. For full dialogue content, call get_conversation next.",
    inputSchema: {
      query: z
        .string()
        .min(1)
        .describe(
          "Case-insensitive substring matched against ChatGPT Web conversation titles",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max hits to return (default 10)"),
      include_archived: z
        .boolean()
        .optional()
        .describe("Also scan archived titles if true (default false)"),
    },
  };
}
