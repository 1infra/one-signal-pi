import { join } from "node:path";
import { homedir } from "node:os";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { DeliveryQueue } from "./delivery.ts";
import { createPendingInputBuffer, createTurnTracker } from "./one-signal.ts";

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function stateDir(): string {
  return process.env.ONE_SIGNAL_STATE_DIR || join(agentDir(), "one-signal-pi");
}

export function resolveBaseUrl(envValue?: string): string {
  return envValue || "https://connector.1infra.io";
}

function createLogger() {
  return (line: string): void => {
    try {
      console.error(line);
    } catch {
      // Ignore stderr failures; telemetry must stay passive.
    }
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function flushAndClose(
  queue: Pick<DeliveryQueue, "flush" | "close">,
  timeoutMs = 2_500,
): Promise<void> {
  try {
    await withTimeout(queue.flush(), timeoutMs);
  } finally {
    queue.close();
  }
}

export default function (pi: ExtensionAPI) {
  const token = process.env.ONE_SIGNAL_API_TOKEN;
  if (!token) {
    return;
  }

  const logger = createLogger();
  const queue = new DeliveryQueue({
    stateDir: stateDir(),
    baseUrl: resolveBaseUrl(process.env.ONE_SIGNAL_BASE_URL),
    apiToken: token,
    logger,
    backoffBaseMs: 500,
  });
  const pendingInput = createPendingInputBuffer();
  let started: Promise<void> | null = null;
  let tracker: ReturnType<typeof createTurnTracker> | null = null;
  let trackerSessionId: string | null = null;

  async function ensureStarted(): Promise<void> {
    if (!started) {
      started = queue.start();
    }
    await started;
  }

  function ensureTracker(sessionId: string, cwd: string) {
    if (!sessionId) {
      return null;
    }
    if (!tracker || trackerSessionId !== sessionId) {
      tracker = createTurnTracker({ sessionId, cwd });
      trackerSessionId = sessionId;
      pendingInput.flushInto(tracker);
    }
    return tracker;
  }

  async function enqueueDrained(current: ReturnType<typeof createTurnTracker> | null): Promise<void> {
    if (!current) {
      return;
    }
    const drained = current.drainPending();
    if (drained.length === 0) {
      return;
    }
    await ensureStarted();
    await queue.enqueue(drained);
  }

  async function safe(handler: () => Promise<void>) {
    try {
      await handler();
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      logger(`one-signal-pi: telemetry handler failed (${message})`);
    }
  }

  pi.on("session_start", async (event, ctx) => {
    await safe(async () => {
      await ensureStarted();
      const current = ensureTracker(ctx.sessionManager.getSessionId(), ctx.cwd);
      current?.onSessionStart(event);
      await enqueueDrained(current);
    });
  });

  pi.on("input", async (event) => {
    await safe(async () => {
      if (!tracker) {
        pendingInput.capture(event);
        return;
      }
      tracker.onInput(event);
    });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await safe(async () => {
      await ensureStarted();
      const current = ensureTracker(ctx.sessionManager.getSessionId(), ctx.cwd);
      current?.onInstructionDocuments(event.systemPromptOptions.contextFiles, agentDir(), 8_000);
      await enqueueDrained(current);
    });
  });

  pi.on("agent_start", async (_event, ctx) => {
    await safe(async () => {
      await ensureStarted();
      const current = ensureTracker(ctx.sessionManager.getSessionId(), ctx.cwd);
      current?.onAgentStart();
    });
  });

  pi.on("turn_start", async (event, ctx) => {
    await safe(async () => {
      const current = ensureTracker(ctx.sessionManager.getSessionId(), ctx.cwd);
      const thinkingLevel = (ctx as { getThinkingLevel?: () => string | null }).getThinkingLevel?.()
        ?? pi.getThinkingLevel?.()
        ?? null;
      current?.onTurnStart(event, thinkingLevel);
      await enqueueDrained(current);
    });
  });

  pi.on("message_end", async (event) => {
    await safe(async () => {
      tracker?.onMessageEnd(event);
      await enqueueDrained(tracker);
    });
  });

  pi.on("tool_execution_start", async (event) => {
    await safe(async () => {
      tracker?.onToolExecutionStart(event);
    });
  });

  pi.on("tool_execution_end", async (event) => {
    await safe(async () => {
      tracker?.onToolExecutionEnd(event);
    });
  });

  pi.on("tool_result", async (event) => {
    await safe(async () => {
      tracker?.onToolResult(event);
      await enqueueDrained(tracker);
    });
  });

  pi.on("turn_end", async (event) => {
    await safe(async () => {
      tracker?.onTurnEnd(event);
      await enqueueDrained(tracker);
    });
  });

  pi.on("agent_settled", async () => {
    await safe(async () => {
      void queue.flush().catch((error) => {
        const message = error instanceof Error ? error.message : "unknown error";
        logger(`one-signal-pi: background flush failed (${message})`);
      });
    });
  });

  pi.on("session_shutdown", async (event, ctx) => {
    await safe(async () => {
      await ensureStarted();
      const current = ensureTracker(ctx.sessionManager.getSessionId(), ctx.cwd);
      current?.onSessionShutdown(event);
      await enqueueDrained(current);
      await flushAndClose(queue);
    });
  });
}
