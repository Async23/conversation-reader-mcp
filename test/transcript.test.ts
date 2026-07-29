import assert from "node:assert/strict";
import test from "node:test";
import { activeBranchTranscript } from "../src/transcript.js";
import type { ConversationDetail } from "../src/chatgpt-client.js";

function node(
  id: string,
  parent: string | null,
  role: string,
  text: string,
  children: string[] = [],
) {
  return {
    id,
    parent,
    children,
    message: {
      id,
      author: { role },
      create_time: 1700000000,
      content: { content_type: "text", parts: [text] },
    },
  };
}

test("returns only the active conversation branch", () => {
  const detail: ConversationDetail = {
    conversation_id: "c1",
    title: "Test chat",
    create_time: 1700000000,
    update_time: 1700001000,
    current_node: "a2",
    mapping: {
      root: { id: "root", parent: null, children: ["u1"], message: null },
      u1: node("u1", "root", "user", "Hello", ["a1", "a2"]),
      a1: node("a1", "u1", "assistant", "Old branch answer", []),
      a2: node("a2", "u1", "assistant", "Active branch answer", []),
    },
  };

  const transcript = activeBranchTranscript(detail);
  assert.equal(transcript.branch, "active");
  assert.equal(transcript.experience, "unknown");
  assert.equal(transcript.messages.length, 2);
  assert.equal(transcript.messages[0]?.content, "Hello");
  assert.equal(transcript.messages[1]?.content, "Active branch answer");
  assert.ok(
    !transcript.messages.some((message) =>
      message.content.includes("Old branch"),
    ),
  );
});

test("preserves meaningful leading and trailing message whitespace", () => {
  const text = "    indented code\n";
  const detail: ConversationDetail = {
    conversation_id: "c1",
    current_node: "u1",
    mapping: {
      u1: node("u1", null, "user", text),
    },
  };

  const transcript = activeBranchTranscript(detail);
  assert.equal(transcript.messages[0]?.content, text);
});

test("formats conversation and message timestamps in the configured timezone", () => {
  const detail: ConversationDetail = {
    conversation_id: "c1",
    create_time: 1_704_067_200,
    update_time: 1_704_070_800_000,
    current_node: "u1",
    mapping: {
      u1: node("u1", null, "user", "Hello"),
    },
  };

  const transcript = activeBranchTranscript(detail, {
    timeZone: "Asia/Shanghai",
  });

  assert.equal(transcript.created_at, "2024-01-01T08:00:00.000+08:00");
  assert.equal(transcript.updated_at, "2024-01-01T09:00:00.000+08:00");
  assert.equal(
    transcript.messages[0]?.created_at,
    "2023-11-15T06:13:20.000+08:00",
  );
});

test("still omits messages whose content is only whitespace", () => {
  const detail: ConversationDetail = {
    conversation_id: "c1",
    current_node: "u1",
    mapping: {
      u1: node("u1", null, "user", "   \n"),
    },
  };

  const transcript = activeBranchTranscript(detail);
  assert.deepEqual(transcript.messages, []);
});

test("reads completed Work dialogue while omitting internal agent activity", () => {
  const detail: ConversationDetail = {
    conversation_id: "work-1",
    title: "Synthetic Work task",
    conversation_origin: "tpp",
    default_model_slug: "gpt-example-wm",
    async_status: null,
    current_node: "final",
    mapping: {
      root: { id: "root", parent: null, children: ["user"], message: null },
      user: {
        id: "user",
        parent: "root",
        children: ["hidden"],
        message: {
          id: "user",
          author: { role: "user" },
          recipient: "all",
          content: { content_type: "text", parts: ["Create a report"] },
        },
      },
      hidden: {
        id: "hidden",
        parent: "user",
        children: ["thoughts"],
        message: {
          id: "hidden",
          author: { role: "assistant" },
          recipient: "SubAgentActivityThreadItem.started",
          content: { content_type: "text", text: "internal activity" },
          metadata: {
            is_visually_hidden_from_conversation: true,
            codex_sub_agent_activity: { kind: "started" },
          },
        },
      },
      thoughts: {
        id: "thoughts",
        parent: "hidden",
        children: ["call"],
        message: {
          id: "thoughts",
          author: { role: "assistant" },
          recipient: "all",
          content: {
            content_type: "thoughts",
            thoughts: [{ summary: "private reasoning" }],
          },
        },
      },
      call: {
        id: "call",
        parent: "thoughts",
        children: ["output"],
        message: {
          id: "call",
          author: { role: "assistant" },
          recipient: "container.exec",
          content: { content_type: "code", text: "internal command" },
        },
      },
      output: {
        id: "output",
        parent: "call",
        children: ["final"],
        message: {
          id: "output",
          author: { role: "tool" },
          recipient: "all",
          content: {
            content_type: "execution_output",
            text: "internal tool output",
          },
        },
      },
      final: {
        id: "final",
        parent: "output",
        children: [],
        message: {
          id: "final",
          author: { role: "assistant" },
          recipient: "all",
          status: "finished_successfully",
          end_turn: true,
          content: {
            content_type: "text",
            text: "Finished report",
          },
          metadata: { working_turn_id: "synthetic-turn" },
        },
      },
    },
  };

  const transcript = activeBranchTranscript(detail);
  assert.equal(transcript.experience, "work");
  assert.equal(transcript.completion_status, "completed");
  assert.equal(transcript.async_status, null);
  assert.deepEqual(
    transcript.messages.map(({ role, content, content_type }) => ({
      role,
      content,
      content_type,
    })),
    [
      { role: "user", content: "Create a report", content_type: "text" },
      { role: "assistant", content: "Finished report", content_type: "text" },
    ],
  );
});
