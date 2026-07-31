import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type BackendMode = "normal" | "no-matches" | "invalid-json";

type ToolPayload = {
  error?: string;
  status?: number | null;
  time_zone?: string;
  conversation_id?: string;
  created_at?: string | null;
  updated_at?: string | null;
  experience?: string;
  completion_status?: string;
  message_count?: number;
  messages?: Array<{
    role?: string;
    content?: string;
    content_type?: string | null;
    created_at?: string | null;
    rich_content?: {
      links?: Array<{ kind?: string; url?: string; title?: string | null }>;
      citations?: Array<{ url?: string; reference_type?: string }>;
      diagrams?: Array<{ format?: string; source?: string }>;
      assets?: Array<{
        asset_id?: string;
        kind?: string;
        name?: string | null;
        mime_type?: string | null;
      }>;
    };
  }>;
  items?: Array<{
    id: string;
    created_at?: string | null;
    updated_at?: string | null;
    experience?: string;
    async_status?: string | null;
  }>;
  has_more?: boolean;
  hits?: Array<{
    conversation_id: string;
    updated_at?: string | null;
    experience?: string;
  }>;
  scanned?: number;
  scan_cap?: number;
};

function parseToolPayload(result: Awaited<ReturnType<Client["callTool"]>>) {
  assert.ok(Array.isArray(result.content));
  const first: unknown = result.content[0];
  assert.ok(first && typeof first === "object");
  assert.ok("type" in first && first.type === "text");
  assert.ok("text" in first && typeof first.text === "string");
  return JSON.parse(first.text) as ToolPayload;
}

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

test("MCP tools preserve archive, pagination, and upstream error semantics", async (t) => {
  let mode: BackendMode = "normal";
  const requestedArchiveFlags: string[] = [];
  let singularDetailRequests = 0;
  let imageAssetId = "";
  let fileAssetId = "";

  const backend = http.createServer(async (request, response) => {
    if (mode === "invalid-json") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html>login</html>");
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname.startsWith("/backend-api/files/download/")) {
      assert.equal(request.method, "GET");
      assert.equal(url.searchParams.get("conversation_id"), "detail-via-xhr");
      assert.equal(url.searchParams.get("inline"), "false");
      const fileId = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      assert.ok(fileId === "file_image" || fileId === "file_report");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          status: "success",
          download_url:
            `http://${request.headers.host}/signed-assets/${fileId}` +
            "?signature=must-not-leak",
          file_name: fileId === "file_image" ? "chart.png" : "report.pdf",
          mime_type: fileId === "file_image" ? "image/png" : "application/pdf",
        }),
      );
      return;
    }

    if (url.pathname.startsWith("/signed-assets/")) {
      assert.equal(request.headers.authorization, "Bearer test-token");
      if (url.pathname.endsWith("/file_image")) {
        const body = Buffer.from([137, 80, 78, 71]);
        response.writeHead(200, {
          "content-type": "image/png",
          "content-length": String(body.byteLength),
        });
        response.end(body);
      } else {
        const body = Buffer.from("%PDF-1.7\n");
        response.writeHead(200, {
          "content-type": "application/pdf",
          "content-length": String(body.byteLength),
        });
        response.end(body);
      }
      return;
    }

    if (url.pathname.startsWith("/backend-api/conversation/")) {
      singularDetailRequests += 1;
      assert.equal(request.method, "GET");
      assert.equal(url.pathname, "/backend-api/conversation/detail-via-xhr");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          conversation_id: "detail-via-xhr",
          title: "Detail through the read-only endpoint",
          create_time: 1_704_067_200,
          update_time: 1_704_070_800,
          conversation_origin: "tpp",
          current_node: "a1",
          mapping: {
            root: {
              id: "root",
              parent: null,
              children: ["u1"],
              message: null,
            },
            u1: {
              id: "u1",
              parent: "root",
              children: ["a1"],
              message: {
                id: "u1",
                author: { role: "user" },
                create_time: 1_704_067_200,
                content: {
                  content_type: "multimodal_text",
                  parts: [
                    "Question [docs](https://example.com/docs)",
                    {
                      content_type: "image_asset_pointer",
                      asset_pointer: "sediment://file_image",
                      mime_type: "image/png",
                      size_bytes: 4,
                      width: 320,
                      height: 200,
                    },
                  ],
                },
                metadata: {
                  attachments: [
                    {
                      id: "file_image",
                      name: "chart.png",
                      mime_type: "image/png",
                      size: 4,
                    },
                    {
                      id: "file_report",
                      name: "report.pdf",
                      mime_type: "application/pdf",
                      size: 9,
                    },
                  ],
                },
              },
            },
            a1: {
              id: "a1",
              parent: "u1",
              children: [],
              message: {
                id: "a1",
                author: { role: "assistant" },
                recipient: "all",
                status: "finished_successfully",
                end_turn: true,
                content: {
                  content_type: "text",
                  parts: [
                    "Answer\n\n```mermaid\ngraph TD\n  A --> B\n```",
                  ],
                },
                metadata: {
                  working_turn_id: "synthetic-turn",
                  content_references: [
                    {
                      type: "sources_footnote",
                      sources: [
                        {
                          title: "Primary source",
                          url: "https://source.example/article",
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
        }),
      );
      return;
    }

    assert.equal(url.pathname, "/backend-api/conversations");
    const archiveFlag = url.searchParams.get("is_archived") ?? "unset";
    requestedArchiveFlags.push(archiveFlag);
    const limit = Number(url.searchParams.get("limit"));
    const offset = Number(url.searchParams.get("offset"));

    if (mode === "no-matches") {
      const items = Array.from({ length: limit }, (_, index) => ({
        id: `${archiveFlag}-${offset + index}`,
        title: "Unrelated title",
        update_time: 1_000 - offset - index,
        is_archived: archiveFlag === "true",
      }));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          items,
          total: 1_000,
          offset,
          limit,
        }),
      );
      return;
    }

    const items =
      archiveFlag === "true"
        ? [
            {
              id: "archived",
              title: "Needle archived",
              update_time: 100,
              is_archived: true,
            },
          ]
        : [
            {
              id: "active",
              title: "Needle active",
              update_time: 200,
              is_archived: false,
              conversation_origin: "tpp",
              async_status: null,
            },
          ];

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        items,
        total: limit === 2 ? 2 : 1,
        offset: 0,
        limit,
      }),
    );
  });

  await new Promise<void>((resolve) =>
    backend.listen(0, "127.0.0.1", resolve),
  );
  const address = backend.address();
  assert.ok(address && typeof address === "object");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/index.ts"],
    cwd: process.cwd(),
    env: {
      ...inheritedEnvironment(),
      READ_MY_CHATGPT_ACCESS_TOKEN: "test-token",
      READ_MY_CHATGPT_BASE_URL: `http://127.0.0.1:${address.port}`,
      READ_MY_CHATGPT_TRANSPORT: "direct",
      READ_MY_CHATGPT_OUTPUT_TIMEZONE: "Asia/Shanghai",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "regression-test", version: "1.0.0" });

  try {
    await client.connect(transport);

    await t.test(
      "get_conversation uses the singular read-only detail endpoint",
      async () => {
        const result = await client.callTool({
          name: "get_conversation",
          arguments: {
            conversation_id: "detail-via-xhr",
            max_messages: 30,
          },
        });
        const payload = parseToolPayload(result);
        assert.notEqual(result.isError, true);
        assert.equal(payload.conversation_id, "detail-via-xhr");
        assert.equal(payload.time_zone, "Asia/Shanghai");
        assert.equal(
          payload.created_at,
          "2024-01-01T08:00:00.000+08:00",
        );
        assert.equal(
          payload.updated_at,
          "2024-01-01T09:00:00.000+08:00",
        );
        assert.equal(payload.experience, "work");
        assert.equal(payload.completion_status, "completed");
        assert.equal(payload.message_count, 2);
        assert.deepEqual(
          payload.messages?.map((message) => message.role),
          ["user", "assistant"],
        );
        assert.equal(
          payload.messages?.[0]?.created_at,
          "2024-01-01T08:00:00.000+08:00",
        );
        assert.equal(
          payload.messages?.[0]?.rich_content?.links?.[0]?.url,
          "https://example.com/docs",
        );
        assert.equal(
          payload.messages?.[1]?.rich_content?.citations?.[0]?.url,
          "https://source.example/article",
        );
        assert.equal(
          payload.messages?.[1]?.rich_content?.diagrams?.[0]?.format,
          "mermaid",
        );
        const assets = payload.messages?.[0]?.rich_content?.assets ?? [];
        imageAssetId =
          assets.find((asset) => asset.kind === "image")?.asset_id ?? "";
        fileAssetId =
          assets.find((asset) => asset.kind === "file")?.asset_id ?? "";
        assert.match(imageAssetId, /^asset_[A-Za-z0-9_-]{32}$/);
        assert.match(fileAssetId, /^asset_[A-Za-z0-9_-]{32}$/);
        assert.equal(singularDetailRequests, 1);
      },
    );

    await t.test(
      "advertises ChatGPT Web scope and configured timestamp semantics",
      async () => {
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
        const instructions = client.getInstructions() ?? "";
        assert.match(
          instructions,
          /authenticated user's ChatGPT Web account at chatgpt\.com/,
        );
        assert.match(
          instructions,
          /only when the requested data source is ChatGPT Web history/,
        );
        assert.match(instructions, /Asia\/Shanghai/);
        for (const tool of tools.tools) {
          assert.match(tool.description ?? "", /ChatGPT Web/);
        }
        const listDescription =
          tools.tools.find((tool) => tool.name === "list_conversations")
            ?.description ?? "";
        assert.match(
          listDescription,
          /Use only for ChatGPT Web history/,
        );
        assert.match(
          listDescription,
          /created_at and updated_at are RFC 3339 timestamps in Asia\/Shanghai/,
        );
        assert.doesNotMatch(
          listDescription,
          /Use when you need recent conversations/,
        );
      },
    );

    await t.test("returns image assets as MCP image content", async () => {
      const result = await client.callTool({
        name: "get_asset",
        arguments: {
          conversation_id: "detail-via-xhr",
          asset_id: imageAssetId,
        },
      });
      assert.notEqual(result.isError, true);
      assert.ok(Array.isArray(result.content));
      assert.equal(result.content.length, 2);
      const summaryBlock: unknown = result.content[0];
      assert.ok(
        summaryBlock &&
          typeof summaryBlock === "object" &&
          "type" in summaryBlock &&
          summaryBlock.type === "text" &&
          "text" in summaryBlock &&
          typeof summaryBlock.text === "string",
      );
      assert.doesNotMatch(summaryBlock.text, /must-not-leak|signed-assets/);
      const imageBlock: unknown = result.content[1];
      assert.deepEqual(imageBlock, {
        type: "image",
        data: Buffer.from([137, 80, 78, 71]).toString("base64"),
        mimeType: "image/png",
      });
    });

    await t.test("returns ordinary files as embedded MCP resources", async () => {
      const result = await client.callTool({
        name: "get_asset",
        arguments: {
          conversation_id: "detail-via-xhr",
          asset_id: fileAssetId,
        },
      });
      assert.notEqual(result.isError, true);
      assert.ok(Array.isArray(result.content));
      const resourceBlock: unknown = result.content[1];
      assert.ok(
        resourceBlock &&
          typeof resourceBlock === "object" &&
          "type" in resourceBlock &&
          resourceBlock.type === "resource" &&
          "resource" in resourceBlock &&
          resourceBlock.resource &&
          typeof resourceBlock.resource === "object",
      );
      const resource = resourceBlock.resource as Record<string, unknown>;
      assert.equal(resource.mimeType, "application/pdf");
      assert.equal(
        typeof resource.blob === "string" ? resource.blob : null,
        Buffer.from("%PDF-1.7\n").toString("base64"),
      );
    });

    await t.test("rejects assets not disclosed by that conversation", async () => {
      const result = await client.callTool({
        name: "get_asset",
        arguments: {
          conversation_id: "detail-via-xhr",
          asset_id: `asset_${"a".repeat(32)}`,
        },
      });
      const payload = parseToolPayload(result);
      assert.equal(result.isError, true);
      assert.equal(payload.error, "asset_not_found");
    });

    await t.test(
      "include_archived searches active and archived conversations",
      async () => {
        requestedArchiveFlags.length = 0;
        const result = await client.callTool({
          name: "search_conversations",
          arguments: { query: "needle", include_archived: true },
        });
        const payload = parseToolPayload(result);
        assert.deepEqual(
          payload.hits
            ?.map((hit) => hit.conversation_id)
            .sort(),
          ["active", "archived"],
        );
        assert.deepEqual(
          Object.fromEntries(
            payload.hits?.map((hit) => [
              hit.conversation_id,
              hit.experience,
            ]) ?? [],
          ),
          { active: "work", archived: "unknown" },
        );
        assert.equal(payload.time_zone, "Asia/Shanghai");
        assert.equal(
          payload.hits?.find(
            (hit) => hit.conversation_id === "active",
          )?.updated_at,
          "1970-01-01T08:03:20.000+08:00",
        );
        assert.deepEqual(
          [...new Set(requestedArchiveFlags)].sort(),
          ["false", "true"],
        );
      },
    );

    await t.test(
      "applies the hit limit after considering both archive scopes",
      async () => {
        requestedArchiveFlags.length = 0;
        const result = await client.callTool({
          name: "search_conversations",
          arguments: {
            query: "needle",
            include_archived: true,
            limit: 1,
          },
        });
        const payload = parseToolPayload(result);
        assert.deepEqual(
          payload.hits?.map((hit) => hit.conversation_id),
          ["active"],
        );
        assert.deepEqual(
          [...new Set(requestedArchiveFlags)].sort(),
          ["false", "true"],
        );
      },
    );

    await t.test("has_more honors an exact upstream total", async () => {
      const result = await client.callTool({
        name: "list_conversations",
        arguments: { limit: 1 },
      });
      const payload = parseToolPayload(result);
      assert.equal(payload.has_more, false);
      assert.equal(payload.time_zone, "Asia/Shanghai");
      assert.equal(
        payload.items?.[0]?.updated_at,
        "1970-01-01T08:03:20.000+08:00",
      );
      assert.equal(payload.items?.[0]?.experience, "work");
    });

    await t.test("has_more detects a partial page with remaining items", async () => {
      const result = await client.callTool({
        name: "list_conversations",
        arguments: { limit: 2 },
      });
      const payload = parseToolPayload(result);
      assert.equal(payload.has_more, true);
    });

    await t.test("combined archive search respects the scan cap", async () => {
      mode = "no-matches";
      requestedArchiveFlags.length = 0;
      const result = await client.callTool({
        name: "search_conversations",
        arguments: { query: "needle", include_archived: true },
      });
      const payload = parseToolPayload(result);
      assert.deepEqual(payload.hits, []);
      assert.equal(payload.scanned, 200);
      assert.equal(payload.scan_cap, 200);
      assert.deepEqual(
        [...new Set(requestedArchiveFlags)].sort(),
        ["false", "true"],
      );
    });

    await t.test(
      "malformed successful responses remain upstream API errors",
      async () => {
        mode = "invalid-json";
        const result = await client.callTool({
          name: "list_conversations",
          arguments: {},
        });
        const payload = parseToolPayload(result);
        assert.equal(result.isError, true);
        assert.equal(payload.error, "chatgpt_api_error");
        assert.equal(payload.status, 200);
      },
    );
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) =>
      backend.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
