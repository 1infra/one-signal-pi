import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildInstructionDocumentTraceUpdate,
  createPendingInputBuffer,
  createTurnTracker,
  sanitizeString,
} from "../src/one-signal.ts";

describe("sanitizeString", () => {
  it("redacts common secrets and keeps valid text", () => {
    const input = [
      "Authorization: Bearer sk-secret-123",
      "ONE_SIGNAL_API_TOKEN=oc_live_456",
      "postgres://user:pass@example.com/db?token=abc123",
      "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    ].join("\n");

    const output = sanitizeString(input, 10_000);

    assert.match(output.text, /\[redacted bearer token\]/);
    assert.match(output.text, /\[redacted secret assignment\]/);
    assert.match(output.text, /\[redacted url secret\]/);
    assert.match(output.text, /\[redacted private key\]/);
    assert.equal(output.truncated, false);
  });

  it("replaces binary-like blobs", () => {
    const output = sanitizeString(`before ${"A".repeat(500)}= after`, 10_000);
    assert.match(output.text, /\[binary content omitted\]/);
  });
});

describe("instruction documents", () => {
  it("keeps global documents without directory_scope and uses readable project-relative scopes", () => {
    const seen = { digest: "" };
    const first = buildInstructionDocumentTraceUpdate({
      sessionId: "session-1",
      agentDir: "/Users/test/.pi/agent",
      contextFiles: [
        { path: "/Users/test/.pi/agent/AGENTS.md", content: "global rule" },
        { path: "/workspace/project/AGENTS.md", content: "project root rule" },
        { path: "/workspace/project/api/AGENTS.md", content: "api rule" },
        { path: "/workspace/project/api/internal/AGENTS.md", content: "internal rule" },
      ],
      maxChars: 1_000,
      previousDigest: seen.digest,
    });

    assert.ok(first);
    seen.digest = first.digest;
    const docs = (first.event.body.metadata as any).instruction_documents;
    assert.equal(docs.length, 4);
    assert.deepEqual(
      docs.map((doc: any) => doc.agent),
      ["pi", "pi", "pi", "pi"],
    );
    assert.deepEqual(
      docs.map((doc: any) => doc.path),
      ["AGENTS.md", "AGENTS.md", "AGENTS.md", "AGENTS.md"],
    );
    assert.equal(docs[0].scope, "global");
    assert.equal(docs[1].scope, "project");
    assert.equal(docs[2].scope, "project");
    assert.equal(docs[3].scope, "project");
    assert.equal(docs[0].directory_scope, undefined);
    assert.equal(docs[1].directory_scope, ".");
    assert.equal(docs[2].directory_scope, "api");
    assert.equal(docs[3].directory_scope, "api/internal");
    assert.ok(!JSON.stringify(first.event).includes("/Users/test"));
    assert.ok(!JSON.stringify(first.event).includes("/workspace/project"));

    const unchanged = buildInstructionDocumentTraceUpdate({
      sessionId: "session-1",
      agentDir: "/Users/test/.pi/agent",
      contextFiles: [
        { path: "/Users/test/.pi/agent/AGENTS.md", content: "global rule" },
        { path: "/workspace/project/AGENTS.md", content: "project root rule" },
        { path: "/workspace/project/api/AGENTS.md", content: "api rule" },
        { path: "/workspace/project/api/internal/AGENTS.md", content: "internal rule" },
      ],
      maxChars: 1_000,
      previousDigest: seen.digest,
    });

    assert.equal(unchanged, null);

    const revised = buildInstructionDocumentTraceUpdate({
      sessionId: "session-1",
      agentDir: "/Users/test/.pi/agent",
      contextFiles: [
        { path: "/Users/test/.pi/agent/AGENTS.md", content: "global rule" },
        { path: "/workspace/project/AGENTS.md", content: "project root rule v2" },
        { path: "/workspace/project/api/AGENTS.md", content: "api rule" },
        { path: "/workspace/project/api/internal/AGENTS.md", content: "internal rule" },
      ],
      maxChars: 1_000,
      previousDigest: seen.digest,
    });

    assert.ok(revised);
    const revisedDocs = (revised.event.body.metadata as any).instruction_documents;
    assert.equal(revisedDocs.length, 4);
    assert.equal(revisedDocs[1].content, "project root rule v2");
    assert.notEqual(revised.digest, seen.digest);
  });

  it("uses the first project context file order for root selection before sorting", () => {
    const update = buildInstructionDocumentTraceUpdate({
      sessionId: "session-1",
      agentDir: "/Users/test/.pi/agent",
      contextFiles: [
        { path: "/workspace/project/api/AGENTS.md", content: "first project root" },
        { path: "/workspace/project/AGENTS.md", content: "outside chosen root" },
        { path: "/workspace/project/api/internal/AGENTS.md", content: "nested" },
      ],
      maxChars: 1_000,
      previousDigest: "",
    });

    assert.ok(update);
    const docs = (update.event.body.metadata as any).instruction_documents;

    assert.equal(docs[0].directory_scope, undefined);
    assert.equal(docs[1].directory_scope, ".");
    assert.equal(docs[2].directory_scope, "internal");
  });

  it("emits A->B->A transitions as distinct envelopes while keeping same-digest no-op", () => {
    const first = buildInstructionDocumentTraceUpdate({
      sessionId: "session-1",
      agentDir: "/Users/test/.pi/agent",
      contextFiles: [{ path: "/repo/AGENTS.md", content: "A" }],
      maxChars: 1_000,
      previousDigest: "",
    });
    assert.ok(first);

    const second = buildInstructionDocumentTraceUpdate({
      sessionId: "session-1",
      agentDir: "/Users/test/.pi/agent",
      contextFiles: [{ path: "/repo/AGENTS.md", content: "B" }],
      maxChars: 1_000,
      previousDigest: first.digest,
    });
    assert.ok(second);

    const third = buildInstructionDocumentTraceUpdate({
      sessionId: "session-1",
      agentDir: "/Users/test/.pi/agent",
      contextFiles: [{ path: "/repo/AGENTS.md", content: "A" }],
      maxChars: 1_000,
      previousDigest: second.digest,
    });
    assert.ok(third);

    assert.notEqual(first.event.id, third.event.id);
    assert.notEqual(second.event.id, third.event.id);

    const unchanged = buildInstructionDocumentTraceUpdate({
      sessionId: "session-1",
      agentDir: "/Users/test/.pi/agent",
      contextFiles: [{ path: "/repo/AGENTS.md", content: "A" }],
      maxChars: 1_000,
      previousDigest: third.digest,
    });
    assert.equal(unchanged, null);
  });
});

describe("turn tracker", () => {
  it("upserts the final turn trace with real user and assistant text while keeping usage/cost on the generation", () => {
    const tracker = createTurnTracker({
      sessionId: "session-1",
      cwd: "/repo",
    });

    tracker.onInput({
      type: "input",
      text: "/skill:code-review inspect this",
      source: "interactive",
      images: [{ type: "image", data: "abc", mimeType: "image/png" }],
    });
    tracker.onSessionStart({ type: "session_start", reason: "startup" });
    tracker.onTurnStart({ type: "turn_start", turnIndex: 3, timestamp: 1_720_000_000_000 });
    tracker.onMessageEnd({
      type: "message_end",
      message: {
        role: "user",
        timestamp: 1_720_000_000_001,
        content: "inspect this",
      },
    } as any);
    tracker.onMessageEnd({
      type: "message_end",
      message: {
        role: "assistant",
        timestamp: 1_720_000_000_100,
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5",
        stopReason: "toolUse",
        usage: {
          input: 11,
          output: 7,
          cacheRead: 3,
          cacheWrite: 0,
          totalTokens: 21,
          cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0, total: 0.33 },
        },
        content: [
          { type: "text", text: "I will use a tool" },
          {
            type: "toolCall",
            id: "tool-1",
            name: "mcp__github__get_pull_request",
            arguments: { number: 42, token: "secret" },
          },
        ],
      },
    } as any);
    tracker.onTurnEnd({
      type: "turn_end",
      turnIndex: 3,
      message: {
        role: "assistant",
        timestamp: 1_720_000_000_200,
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5",
        stopReason: "stop",
        usage: {
          input: 11,
          output: 7,
          cacheRead: 3,
          cacheWrite: 0,
          totalTokens: 21,
          cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0, total: 0.33 },
        },
        content: [{ type: "text", text: "done" }],
      },
      toolResults: [],
    } as any);

    const batch = tracker.drainPending();
    const turnTrace = batch.find((event: any) => event.type === "trace-create" && event.body.id.includes(":turn:3"));
    const generation = batch.find((event: any) => event.body?.type === "GENERATION");

    assert.ok(turnTrace);
    assert.deepEqual(turnTrace.body.input, { role: "user", content: "inspect this" });
    assert.deepEqual(turnTrace.body.output, { role: "assistant", content: "done" });
    assert.equal(turnTrace.body.sessionId, "session-1");
    assert.equal((turnTrace.body.metadata as any).source, "pi");
    assert.equal((turnTrace.body.metadata as any).turn_index, 3);
    assert.deepEqual((turnTrace.body.metadata as any).skill_names, ["code-review"]);
    assert.equal((turnTrace.body.metadata as any).omitted_image_count, 1);
    assert.equal(generation?.body.model, "gpt-5");
    assert.equal((generation?.body.usageDetails as any).total, 21);
    assert.equal((generation?.body.costDetails as any).total, 0.33);
  });

  it("ignores raw thinking blocks in assistant summaries and final traces", () => {
    const tracker = createTurnTracker({
      sessionId: "session-1",
      cwd: "/repo",
    });

    tracker.onTurnStart({ type: "turn_start", turnIndex: 1, timestamp: 1_720_000_000_000 });
    tracker.onMessageEnd({
      type: "message_end",
      message: {
        role: "assistant",
        timestamp: 1_720_000_000_100,
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5",
        stopReason: "stop",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        content: [
          { type: "thinking", thinking: "SENTINEL_THINKING" },
          { type: "text", text: "final answer" },
        ],
      },
    } as any);
    tracker.onTurnEnd({
      type: "turn_end",
      turnIndex: 1,
      message: {
        role: "assistant",
        timestamp: 1_720_000_000_200,
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5",
        stopReason: "stop",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        content: [
          { type: "thinking", thinking: "SENTINEL_THINKING" },
          { type: "text", text: "final answer" },
        ],
      },
      toolResults: [],
    } as any);

    const batch = tracker.drainPending();
    const serialized = JSON.stringify(batch);

    assert.match(serialized, /final answer/);
    assert.doesNotMatch(serialized, /SENTINEL_THINKING/);
  });

  it("uses the exact session end server contract and never sets it on reload", () => {
    const tracker = createTurnTracker({ sessionId: "session-1", cwd: "/repo" });
    tracker.onSessionStart({ type: "session_start", reason: "startup" });
    tracker.onSessionShutdown({ type: "session_shutdown", reason: "reload" });
    tracker.onSessionShutdown({ type: "session_shutdown", reason: "quit" });
    tracker.onSessionShutdown({ type: "session_shutdown", reason: "quit" });

    const batch = tracker.drainPending();
    const sessionTraceUpserts = batch.filter((event: any) => event.type === "trace-create" && event.body.id === "session:session-1");
    const withSessionEnd = sessionTraceUpserts.filter((event: any) => (event.body.metadata as any).session_end_reason);
    const strayObservation = batch.find((event: any) => event.body?.name === "Session End");

    assert.equal(withSessionEnd.length, 1);
    assert.equal((withSessionEnd[0].body.metadata as any).session_end_reason, "quit");
    assert.equal(strayObservation, undefined);
  });

  it("combines tool execution timing with the final tool result without duplicate tool spans", () => {
    const tracker = createTurnTracker({ sessionId: "session-1", cwd: "/repo" });
    tracker.onTurnStart({ type: "turn_start", turnIndex: 1, timestamp: 1_720_000_000_000 });
    tracker.onToolExecutionStart({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "echo hi" },
    } as any, 1_720_000_000_100);
    tracker.onToolExecutionEnd({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "bash",
      result: "boom",
      isError: true,
    } as any, 1_720_000_000_350);
    tracker.onToolResult({
      type: "tool_result",
      toolCallId: "tool-1",
      toolName: "bash",
      input: { command: "echo hi" },
      content: [{ type: "text", text: "boom" }],
      isError: true,
    } as any);

    const batch = tracker.drainPending();
    const spans = batch.filter((event: any) => event.body?.metadata?.tool_id === "tool-1");

    assert.equal(spans.length, 1);
    assert.equal(spans[0].body.startTime, new Date(1_720_000_000_100).toISOString());
    assert.equal(spans[0].body.endTime, new Date(1_720_000_000_350).toISOString());
    assert.equal((spans[0].body.metadata as any).duration_ms, 250);
    assert.equal((spans[0].body.metadata as any).result_status, "error");
  });

  it("prefers string MCP attribution from event details and never uploads raw details", () => {
    const tracker = createTurnTracker({ sessionId: "session-1", cwd: "/repo" });
    tracker.onTurnStart({ type: "turn_start", turnIndex: 1, timestamp: 1_720_000_000_000 });
    tracker.onToolResult({
      type: "tool_result",
      toolCallId: "tool-1",
      toolName: "custom-tool",
      input: { query: "value" },
      details: {
        server: "custom-server",
        tool: "custom-tool-name",
        sentinel: "must-not-leak",
      },
      content: [{ type: "text", text: "ok" }],
      isError: false,
    } as any);

    const batch = tracker.drainPending();
    const span = batch.find((event: any) => event.body?.metadata?.tool_id === "tool-1");

    assert.ok(span);
    assert.equal((span.body.metadata as any).mcp_server, "custom-server");
    assert.equal((span.body.metadata as any).mcp_tool, "custom-tool-name");
    assert.equal((span.body.metadata as Record<string, unknown>).sentinel, undefined);
    assert.doesNotMatch(JSON.stringify(span), /must-not-leak/);
  });

  it("falls back to proxy MCP input fields when toolName is mcp", () => {
    const tracker = createTurnTracker({ sessionId: "session-1", cwd: "/repo" });
    tracker.onTurnStart({ type: "turn_start", turnIndex: 1, timestamp: 1_720_000_000_000 });
    tracker.onToolResult({
      type: "tool_result",
      toolCallId: "tool-1",
      toolName: "mcp",
      input: {
        server: "proxy-server",
        tool: "proxy-tool",
        details: "omit-me",
      },
      content: [{ type: "text", text: "ok" }],
      isError: false,
    } as any);

    const batch = tracker.drainPending();
    const span = batch.find((event: any) => event.body?.metadata?.tool_id === "tool-1");

    assert.ok(span);
    assert.equal((span.body.metadata as any).mcp_server, "proxy-server");
    assert.equal((span.body.metadata as any).mcp_tool, "proxy-tool");
  });

  it("falls back to encoded MCP tool names", () => {
    const tracker = createTurnTracker({ sessionId: "session-1", cwd: "/repo" });
    tracker.onTurnStart({ type: "turn_start", turnIndex: 1, timestamp: 1_720_000_000_000 });
    tracker.onToolResult({
      type: "tool_result",
      toolCallId: "tool-1",
      toolName: "mcp__github__get_pull_request",
      input: { number: 42 },
      content: [{ type: "text", text: "ok" }],
      isError: false,
    } as any);

    const batch = tracker.drainPending();
    const span = batch.find((event: any) => event.body?.metadata?.tool_id === "tool-1");

    assert.ok(span);
    assert.equal((span.body.metadata as any).mcp_server, "github");
    assert.equal((span.body.metadata as any).mcp_tool, "get_pull_request");
  });

  it("keeps turn ids distinct across agent runs even when turnIndex resets to zero", () => {
    const tracker = createTurnTracker({ sessionId: "session-1", cwd: "/repo" });

    tracker.onAgentStart();
    tracker.onInput({ type: "input", text: "first turn", source: "interactive" });
    tracker.onTurnStart({ type: "turn_start", turnIndex: 0, timestamp: 1_720_000_000_000 });
    tracker.onTurnEnd({
      type: "turn_end",
      turnIndex: 0,
      message: {
        role: "assistant",
        timestamp: 1_720_000_000_010,
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5",
        stopReason: "stop",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        content: [{ type: "text", text: "first answer" }],
      },
      toolResults: [],
    } as any);

    tracker.onAgentStart();
    tracker.onInput({ type: "input", text: "second turn", source: "interactive" });
    tracker.onTurnStart({ type: "turn_start", turnIndex: 0, timestamp: 1_720_000_001_000 });
    tracker.onTurnStart({ type: "turn_start", turnIndex: 0, timestamp: 1_720_000_001_000 });
    tracker.onTurnEnd({
      type: "turn_end",
      turnIndex: 0,
      message: {
        role: "assistant",
        timestamp: 1_720_000_001_010,
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5",
        stopReason: "stop",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        content: [{ type: "text", text: "second answer" }],
      },
      toolResults: [],
    } as any);

    const batch = tracker.drainPending();
    const turnTraces = batch.filter((event: any) => event.type === "trace-create" && /:trace:final:/.test(event.id));

    assert.equal(turnTraces.length, 2);
    assert.notEqual(turnTraces[0].body.id, turnTraces[1].body.id);
    assert.deepEqual(
      turnTraces.map((event: any) => event.body.output?.content),
      ["first answer", "second answer"],
    );
  });
});

describe("pre-session input buffer", () => {
  it("holds explicit input until a real session tracker exists", () => {
    const buffer = createPendingInputBuffer();
    buffer.capture({
      type: "input",
      text: "/skill:review check this",
      source: "interactive",
    });

    const tracker = createTurnTracker({ sessionId: "real-session", cwd: "/repo" });
    buffer.flushInto(tracker);
    tracker.onTurnStart({ type: "turn_start", turnIndex: 1, timestamp: 1_720_000_000_000 });
    tracker.onTurnEnd({
      type: "turn_end",
      turnIndex: 1,
      message: {
        role: "assistant",
        timestamp: 1_720_000_000_010,
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5",
        stopReason: "stop",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        content: [{ type: "text", text: "done" }],
      },
      toolResults: [],
    } as any);

    const batch = tracker.drainPending();
    const turnTrace = batch.find((event: any) => event.type === "trace-create" && event.body.id.includes(":turn:1"));

    assert.ok(turnTrace);
    assert.deepEqual(turnTrace.body.input, { role: "user", content: "/skill:review check this" });
    assert.deepEqual((turnTrace.body.metadata as any).skill_names, ["review"]);
  });
});

describe("instruction document scope boundaries", () => {
  it("treats real children as global, keeps ..config inside, and rejects prefix collisions and parent traversal", () => {
    const update = buildInstructionDocumentTraceUpdate({
      sessionId: "session-1",
      agentDir: "/Users/test/.pi/agent",
      contextFiles: [
        { path: "/Users/test/.pi/agent/AGENTS.md", content: "global root" },
        { path: "/Users/test/.pi/agent/sub/AGENTS.md", content: "global child" },
        { path: "/Users/test/.pi/agent/..config/AGENTS.md", content: "dot child" },
        { path: "/Users/test/.pi/agent-evil/AGENTS.md", content: "prefix collision" },
        { path: "/Users/test/.pi/agent/../outside/AGENTS.md", content: "parent traversal" },
      ],
      maxChars: 1_000,
      previousDigest: "",
    });

    assert.ok(update);
    const docs = (update.event.body.metadata as any).instruction_documents;

    assert.deepEqual(
      docs.map((doc: any) => doc.scope),
      ["global", "global", "global", "project", "project"],
    );
    assert.equal(docs[2].directory_scope, undefined);
    assert.ok(!JSON.stringify(update.event).includes("/Users/test/.pi/agent"));
    assert.ok(!JSON.stringify(update.event).includes("/Users/test/.pi/outside"));
  });
});
