import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";

import type {
  ExtensionEvent,
  InputEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolResultEvent,
  TurnEndEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";

type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

type MessageEndEvent = Extract<ExtensionEvent, { type: "message_end" }>;
type ToolExecutionStartEvent = Extract<ExtensionEvent, { type: "tool_execution_start" }>;
type ToolExecutionEndEvent = Extract<ExtensionEvent, { type: "tool_execution_end" }>;

export type IngestEvent = {
  id: string;
  timestamp: string;
  type: "trace-create" | "observation-create";
  body: Record<string, Json>;
};

type SnapshotFile = { path: string; content: string };
type InstructionDocument = {
  agent: "pi";
  path: "AGENTS.md" | "CLAUDE.md";
  scope: "global" | "project";
  directory_scope?: string;
  content: string;
  content_hash: string;
};

type PendingTurn = {
  key: string;
  runKey: string;
  turnIndex: number;
  traceId: string;
  skillNames: string[];
  userText: string | null;
  userImageCount: number;
  assistantText: string | null;
  assistantImageCount: number;
  thinkingLevel: string | null;
  generationIdsByToolCallId: Map<string, string>;
  generationCount: number;
};

type ToolTiming = {
  toolName: string;
  startTime?: number;
  endTime?: number;
  isError?: boolean;
};

type InstructionDocumentUpdateInput = {
  sessionId: string;
  agentDir: string;
  contextFiles: SnapshotFile[] | undefined;
  maxChars: number;
  previousDigest: string;
};

type InstructionDocumentUpdate = {
  digest: string;
  documents: InstructionDocument[];
  event: IngestEvent;
};

const DEFAULT_MAX_CHARS = 20_000;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function iso(value: number | string): string {
  if (typeof value === "number") {
    return new Date(value).toISOString();
  }
  const asDate = new Date(value);
  return Number.isNaN(asDate.getTime()) ? new Date(0).toISOString() : asDate.toISOString();
}

function normalizeAgentDir(agentDir?: string): string {
  return agentDir?.trim() || join(homedir(), ".pi", "agent");
}

function normalizeContextName(pathname: string): "AGENTS.md" | "CLAUDE.md" | null {
  const upper = basename(pathname).toUpperCase();
  if (upper === "AGENTS.MD") {
    return "AGENTS.md";
  }
  if (upper === "CLAUDE.MD") {
    return "CLAUDE.md";
  }
  return null;
}

function detectSkillNames(text: string | undefined): string[] {
  if (!text) {
    return [];
  }
  const match = text.match(/^\/skill:([A-Za-z0-9._-]+)/);
  return match ? [match[1]] : [];
}

function parseMcp(toolName: string | undefined): { server: string; tool: string } | null {
  if (!toolName || !toolName.startsWith("mcp__")) {
    return null;
  }
  const segments = toolName.split("__");
  if (segments.length < 3 || !segments[1] || !segments[2]) {
    return null;
  }
  return {
    server: segments[1],
    tool: segments.slice(2).join("__"),
  };
}

function readStringProperty(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const entry = (value as Record<string, unknown>)[key];
  return typeof entry === "string" ? entry : null;
}

function extractMcpAttribution(event: ToolResultEvent): { server: string; tool: string } | null {
  const detailServer = readStringProperty(event.details, "server");
  const detailTool = readStringProperty(event.details, "tool");
  if (detailServer && detailTool) {
    return { server: detailServer, tool: detailTool };
  }

  if (event.toolName === "mcp") {
    const inputServer = readStringProperty(event.input, "server");
    const inputTool = readStringProperty(event.input, "tool");
    if (inputServer && inputTool) {
      return { server: inputServer, tool: inputTool };
    }
  }

  return parseMcp(event.toolName);
}

function isSafeContainedRelative(delta: string): boolean {
  return delta === "" || (!isAbsolute(delta) && delta !== ".." && !delta.startsWith(`..${sep}`));
}

function isInsideOrEqual(resolvedParent: string, resolvedChild: string): boolean {
  const delta = relative(resolvedParent, resolvedChild);
  return isSafeContainedRelative(delta);
}

function eventEnvelope(
  envelopeId: string,
  type: IngestEvent["type"],
  body: Record<string, Json>,
  timestamp: number | string,
): IngestEvent {
  return {
    id: envelopeId,
    timestamp: iso(timestamp),
    type,
    body,
  };
}

function sanitizeUnknown(value: unknown, maxChars = DEFAULT_MAX_CHARS): Json {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return sanitizeString(value, maxChars).text;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeUnknown(entry, maxChars));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !["thinkingSignature", "thoughtSignature", "details", "headers"].includes(key))
        .map(([key, entry]) => {
          if (/(token|secret|key|password)/i.test(key)) {
            return [key, "[redacted secret assignment]"] as const;
          }
          return [key, sanitizeUnknown(entry, maxChars)] as const;
        }),
    );
  }
  return String(value);
}

function summarizeContent(content: unknown, maxChars = DEFAULT_MAX_CHARS): { text: string | null; omittedImages: number } {
  if (typeof content === "string") {
    return {
      text: sanitizeString(content, maxChars).text,
      omittedImages: 0,
    };
  }

  if (!Array.isArray(content)) {
    const sanitized = sanitizeUnknown(content, maxChars);
    return {
      text: typeof sanitized === "string" ? sanitized : sanitized === null ? null : JSON.stringify(sanitized),
      omittedImages: 0,
    };
  }

  const parts: string[] = [];
  let omittedImages = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const type = (block as Record<string, unknown>).type;
    if (type === "text" || type === "input_text" || type === "output_text") {
      parts.push(String((block as Record<string, unknown>).text ?? ""));
      continue;
    }
    if (type === "thinking") {
      continue;
    }
    if (type === "image") {
      omittedImages += 1;
    }
  }

  const joined = sanitizeString(parts.join("\n\n"), maxChars).text;
  return {
    text: joined || null,
    omittedImages,
  };
}

function assistantToolCalls(content: unknown): Array<{ id: string; name: string }> {
  if (!Array.isArray(content)) {
    return [];
  }
  const result: Array<{ id: string; name: string }> = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || (block as Record<string, unknown>).type !== "toolCall") {
      continue;
    }
    const id = String((block as Record<string, unknown>).id ?? "");
    const name = String((block as Record<string, unknown>).name ?? "");
    if (id && name) {
      result.push({ id, name });
    }
  }
  return result;
}

function toDirectoryScope(projectRoot: string | null, pathname: string): string | undefined {
  if (!projectRoot) {
    return undefined;
  }

  const delta = relative(projectRoot, dirname(pathname));
  if (!isSafeContainedRelative(delta)) {
    return undefined;
  }

  return delta === "" ? "." : delta;
}

function classifyInstructionFile(
  file: SnapshotFile,
  resolvedAgentDir: string,
): { normalizedPath: "AGENTS.md" | "CLAUDE.md"; scope: "global" | "project" } | null {
  const normalizedPath = normalizeContextName(file.path);
  if (!normalizedPath) {
    return null;
  }

  return {
    normalizedPath,
    scope: isInsideOrEqual(resolvedAgentDir, resolve(file.path)) ? "global" : "project",
  };
}

function toInstructionDocument(
  file: SnapshotFile,
  metadata: { normalizedPath: "AGENTS.md" | "CLAUDE.md"; scope: "global" | "project" },
  projectRoot: string | null,
  maxChars: number,
): InstructionDocument {
  const sanitized = sanitizeString(file.content, maxChars);
  const directoryScope = metadata.scope === "project" ? toDirectoryScope(projectRoot, file.path) : undefined;
  return {
    agent: "pi",
    path: metadata.normalizedPath,
    scope: metadata.scope,
    ...(directoryScope ? { directory_scope: directoryScope } : {}),
    content: sanitized.text,
    content_hash: sha256(file.content),
  };
}

export function sanitizeString(value: string, maxChars = DEFAULT_MAX_CHARS): { text: string; truncated: boolean } {
  let text = value.replace(/\r\n/g, "\n");
  text = text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]");
  text = text.replace(/\bAuthorization:\s*Bearer\s+[A-Za-z0-9._-]+\b/gi, "Authorization: [redacted bearer token]");
  text = text.replace(/\b(Bearer)\s+[A-Za-z0-9._-]{10,}\b/g, "[redacted bearer token]");
  text = text.replace(/\b([A-Z0-9_]*(TOKEN|SECRET|KEY|PASSWORD)[A-Z0-9_]*)\s*=\s*([^\s'"]+)/gi, "$1=[redacted secret assignment]");
  text = text.replace(/([?&](?:token|key|api_key|access_token|auth|password|secret)=)([^&#\s]+)/gi, "$1[redacted url secret]");
  text = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/gi, "[redacted url secret]@");
  text = text.replace(/[A-Za-z0-9+/]{256,}={0,2}/g, "[binary content omitted]");

  const truncated = text.length > maxChars;
  if (truncated) {
    text = `${text.slice(0, Math.max(maxChars - 14, 0))}[truncated]`;
  }
  return { text, truncated };
}

export function buildInstructionDocumentTraceUpdate(
  input: InstructionDocumentUpdateInput,
): InstructionDocumentUpdate | null {
  const resolvedAgentDir = resolve(normalizeAgentDir(input.agentDir));
  const candidates = (input.contextFiles ?? [])
    .map((file) => {
      const metadata = classifyInstructionFile(file, resolvedAgentDir);
      return metadata ? { file, metadata } : null;
    })
    .filter((entry): entry is { file: SnapshotFile; metadata: { normalizedPath: "AGENTS.md" | "CLAUDE.md"; scope: "global" | "project" } } => entry !== null);
  const firstProjectCandidate = candidates.find((entry) => entry.metadata.scope === "project");
  const projectRoot = firstProjectCandidate ? resolve(dirname(firstProjectCandidate.file.path)) : null;

  const documents = candidates
    .map((entry) => ({
      pathname: entry.file.path,
      document: toInstructionDocument(entry.file, entry.metadata, projectRoot, input.maxChars),
    }))
    .sort((a, b) => {
      const left = `${a.document.scope}:${a.pathname}`;
      const right = `${b.document.scope}:${b.pathname}`;
      return left.localeCompare(right);
    })
    .map((entry) => entry.document);

  const digest = sha256(JSON.stringify(documents));
  if (digest === input.previousDigest) {
    return null;
  }

  return {
    digest,
    documents,
    event: eventEnvelope(
      `session:${input.sessionId}:trace:documents:${input.previousDigest || "none"}:${digest}`,
      "trace-create",
      {
        id: `session:${input.sessionId}`,
        timestamp: iso(Date.now()),
        name: `Pi Session ${input.sessionId}`,
        sessionId: input.sessionId,
        input: null,
        output: null,
        metadata: {
          source: "pi",
          instruction_documents: documents,
        },
      },
      Date.now(),
    ),
  };
}

export function createPendingInputBuffer() {
  let pending: InputEvent | null = null;

  return {
    capture(event: InputEvent): void {
      pending = event;
    },
    flushInto(tracker: ReturnType<typeof createTurnTracker>): void {
      if (!pending) {
        return;
      }
      tracker.onInput(pending);
      pending = null;
    },
    clear(): void {
      pending = null;
    },
  };
}

export function createTurnTracker(options: { sessionId: string; cwd: string }) {
  const pending: IngestEvent[] = [];
  const turns = new Map<string, PendingTurn>();
  const toolTimings = new Map<string, ToolTiming>();
  let bufferedInputText: string | null = null;
  let bufferedInputImageCount = 0;
  let bufferedSkillNames: string[] = [];
  let instructionDocuments: InstructionDocument[] = [];
  let instructionDocumentsDigest = "";
  let sessionEndReason: string | null = null;
  let activeRunKey = "bootstrap";
  let awaitingRunKey = false;
  let runSequence = 0;

  function push(event: IngestEvent): void {
    pending.push(event);
  }

  function sessionTraceId(): string {
    return `session:${options.sessionId}`;
  }

  function turnTraceId(runKey: string, turnIndex: number): string {
    return `${sessionTraceId()}:run:${runKey}:turn:${turnIndex}`;
  }

  function sessionTraceUpsert(timestamp: number | string, suffix: string): IngestEvent {
    return eventEnvelope(
      `${sessionTraceId()}:trace:${suffix}`,
      "trace-create",
      {
        id: sessionTraceId(),
        timestamp: iso(timestamp),
        name: `Pi Session ${options.sessionId}`,
        sessionId: options.sessionId,
        input: null,
        output: null,
        metadata: {
          source: "pi",
          ...(instructionDocuments.length > 0 ? { instruction_documents: instructionDocuments } : {}),
          ...(sessionEndReason ? { session_end_reason: sessionEndReason } : {}),
        },
      },
      timestamp,
    );
  }

  function currentRunKey(timestamp?: number): string {
    if (awaitingRunKey) {
      const resolved = typeof timestamp === "number" ? `ts-${timestamp}` : `run-${++runSequence}`;
      activeRunKey = resolved;
      awaitingRunKey = false;
    }
    return activeRunKey;
  }

  function turnMapKey(runKey: string, turnIndex: number): string {
    return `${options.sessionId}:${runKey}:${turnIndex}`;
  }

  function ensureTurn(turnIndex: number, timestamp?: number, thinkingLevel?: string | null): PendingTurn {
    const runKey = currentRunKey(timestamp);
    const key = turnMapKey(runKey, turnIndex);
    const existing = turns.get(key);
    if (existing) {
      if (thinkingLevel) {
        existing.thinkingLevel = thinkingLevel;
      }
      return existing;
    }
    const created: PendingTurn = {
      key,
      runKey,
      turnIndex,
      traceId: turnTraceId(runKey, turnIndex),
      skillNames: bufferedSkillNames,
      userText: bufferedInputText,
      userImageCount: bufferedInputImageCount,
      assistantText: null,
      assistantImageCount: 0,
      thinkingLevel: thinkingLevel ?? null,
      generationIdsByToolCallId: new Map(),
      generationCount: 0,
    };
    bufferedInputText = null;
    bufferedInputImageCount = 0;
    bufferedSkillNames = [];
    turns.set(key, created);
    return created;
  }

  function currentTurn(): PendingTurn | undefined {
    const values = [...turns.values()];
    return values.at(-1);
  }

  return {
    onAgentStart(): void {
      awaitingRunKey = true;
      activeRunKey = `pending-${++runSequence}`;
    },

    onInput(event: InputEvent): void {
      const summary = summarizeContent(event.text);
      bufferedInputText = summary.text;
      bufferedInputImageCount = event.images?.length ?? 0;
      bufferedSkillNames = detectSkillNames(event.text);
    },

    onSessionStart(event: SessionStartEvent): void {
      sessionEndReason = null;
      push(sessionTraceUpsert(Date.now(), `start:${event.reason}`));
    },

    onInstructionDocuments(contextFiles: SnapshotFile[] | undefined, agentDir: string, maxChars: number): void {
      const update = buildInstructionDocumentTraceUpdate({
        sessionId: options.sessionId,
        agentDir,
        contextFiles,
        maxChars,
        previousDigest: instructionDocumentsDigest,
      });
      if (!update) {
        return;
      }
      instructionDocuments = update.documents;
      instructionDocumentsDigest = update.digest;
      push(update.event);
    },

    onSessionShutdown(event: SessionShutdownEvent): void {
      if (event.reason === "reload") {
        return;
      }
      if (sessionEndReason === event.reason) {
        return;
      }
      sessionEndReason = event.reason;
      push(sessionTraceUpsert(Date.now(), `shutdown:${event.reason}`));
    },

    onTurnStart(event: TurnStartEvent, thinkingLevel?: string | null): void {
      ensureTurn(event.turnIndex, event.timestamp, thinkingLevel);
    },

    onMessageEnd(event: MessageEndEvent): void {
      const turn = currentTurn();
      if (!turn) {
        return;
      }

      if (event.message.role === "user") {
        const summary = summarizeContent(event.message.content);
        turn.userText = summary.text;
        turn.userImageCount = Math.max(turn.userImageCount, summary.omittedImages);
        return;
      }

      if (event.message.role !== "assistant") {
        return;
      }

      const summary = summarizeContent(event.message.content);
      turn.assistantText = summary.text;
      turn.assistantImageCount = summary.omittedImages;
      turn.generationCount += 1;

      const generationId = `${turn.traceId}:generation:${turn.generationCount}:${sha256(`${event.message.timestamp}:${summary.text ?? ""}`)}`;
      const toolCalls = assistantToolCalls(event.message.content);
      for (const toolCall of toolCalls) {
        turn.generationIdsByToolCallId.set(toolCall.id, generationId);
      }

      push(
        eventEnvelope(
          generationId,
          "observation-create",
          {
            id: generationId,
            traceId: turn.traceId,
            parentObservationId: null,
            type: "GENERATION",
            name: `Assistant Generation ${turn.generationCount}`,
            startTime: iso(event.message.timestamp),
            endTime: iso(event.message.timestamp),
            output: {
              role: "assistant",
              content: summary.text,
            },
            model: event.message.model,
            usageDetails: {
              input: event.message.usage.input,
              output: event.message.usage.output,
              cache_read_input_tokens: event.message.usage.cacheRead,
              cache_write_input_tokens: event.message.usage.cacheWrite,
              total: event.message.usage.totalTokens,
            },
            costDetails: sanitizeUnknown(event.message.usage.cost),
            metadata: {
              source: "pi",
              provider: event.message.provider,
              api: event.message.api,
              stop_reason: event.message.stopReason,
              tool_count: toolCalls.length,
            },
          },
          event.message.timestamp,
        ),
      );
    },

    onToolExecutionStart(event: ToolExecutionStartEvent, timestamp = Date.now()): void {
      toolTimings.set(event.toolCallId, {
        toolName: event.toolName,
        startTime: timestamp,
      });
    },

    onToolExecutionEnd(event: ToolExecutionEndEvent, timestamp = Date.now()): void {
      const previous = toolTimings.get(event.toolCallId) ?? { toolName: event.toolName };
      toolTimings.set(event.toolCallId, {
        ...previous,
        toolName: event.toolName,
        endTime: timestamp,
        isError: event.isError,
      });
    },

    onToolResult(event: ToolResultEvent, timestamp = Date.now()): void {
      const turn = currentTurn();
      if (!turn) {
        return;
      }
      const timing = toolTimings.get(event.toolCallId);
      const input = sanitizeUnknown(event.input);
      const output = summarizeContent(event.content).text;
      const mcp = extractMcpAttribution(event);
      const startTime = timing?.startTime ?? timestamp;
      const endTime = timing?.endTime ?? timestamp;
      push(
        eventEnvelope(
          `${turn.traceId}:tool:${event.toolCallId}`,
          "observation-create",
          {
            id: `${turn.traceId}:tool:${event.toolCallId}`,
            traceId: turn.traceId,
            parentObservationId: turn.generationIdsByToolCallId.get(event.toolCallId) ?? null,
            type: "SPAN",
            name: `Tool: ${event.toolName}`,
            startTime: iso(startTime),
            endTime: iso(endTime),
            input,
            output,
            metadata: {
              source: "pi",
              tool_id: event.toolCallId,
              tool_name: event.toolName,
              result_status: event.isError || timing?.isError ? "error" : "success",
              duration_ms: Math.max(0, endTime - startTime),
              ...(mcp ? { mcp_server: mcp.server, mcp_tool: mcp.tool } : {}),
            },
          },
          endTime,
        ),
      );
      toolTimings.delete(event.toolCallId);
    },

    onTurnEnd(event: TurnEndEvent): void {
      const turn = ensureTurn(event.turnIndex, event.message.timestamp);
      if (event.message.role === "assistant") {
        const summary = summarizeContent(event.message.content);
        turn.assistantText = summary.text;
        turn.assistantImageCount = summary.omittedImages;
      }

      const omittedImageCount = turn.userImageCount + turn.assistantImageCount;
      const signature = sha256(JSON.stringify({
        input: turn.userText,
        output: turn.assistantText,
        skills: turn.skillNames,
        omittedImageCount,
      }));

      push(
        eventEnvelope(
          `${turn.traceId}:trace:final:${signature}`,
          "trace-create",
          {
            id: turn.traceId,
            timestamp: iso(event.message.timestamp),
            name: `Pi Turn ${event.turnIndex}`,
            sessionId: options.sessionId,
            input: turn.userText ? { role: "user", content: turn.userText } : null,
            output: turn.assistantText ? { role: "assistant", content: turn.assistantText } : null,
            metadata: {
              source: "pi",
              turn_index: event.turnIndex,
              run_key: turn.runKey,
              skill_names: turn.skillNames,
              omitted_image_count: omittedImageCount,
              ...(turn.thinkingLevel ? { thinking_level: turn.thinkingLevel } : {}),
            },
          },
          event.message.timestamp,
        ),
      );
      turns.delete(turn.key);
    },

    drainPending(): IngestEvent[] {
      const drained = pending.slice();
      pending.length = 0;
      return drained;
    },
  };
}
