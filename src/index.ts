import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { DeliveryQueue } from "./delivery.ts";
import { createPendingInputBuffer, createTurnTracker } from "./one-signal.ts";

type RuntimeConfig = {
  agentDir: string;
  stateDir: string;
  apiToken?: string;
  baseUrl: string;
};

type PersistentConfig = Partial<{
  ONE_SIGNAL_API_TOKEN: string;
  ONE_SIGNAL_BASE_URL: string;
}>;

function resolveAgentDir(env: NodeJS.ProcessEnv, homeDir: string): string {
  return env.PI_CODING_AGENT_DIR || join(homeDir, ".pi", "agent");
}

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env, homeDir = homedir()): string {
  return env.ONE_SIGNAL_STATE_DIR || join(resolveAgentDir(env, homeDir), "one-signal-pi");
}

export function resolveBaseUrl(envValue?: string): string {
  return envValue === undefined ? "https://connector.1infra.io" : envValue || "https://connector.1infra.io";
}

function loadPersistentConfig(stateDir: string): PersistentConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const objectConfig = parsed as Record<string, unknown>;

    const config: PersistentConfig = {};
    if (typeof objectConfig.ONE_SIGNAL_API_TOKEN === "string") {
      config.ONE_SIGNAL_API_TOKEN = objectConfig.ONE_SIGNAL_API_TOKEN;
    }
    if (typeof objectConfig.ONE_SIGNAL_BASE_URL === "string") {
      config.ONE_SIGNAL_BASE_URL = objectConfig.ONE_SIGNAL_BASE_URL;
    }
    return config;
  } catch {
    return {};
  }
}

export function resolveRuntimeConfig(env: NodeJS.ProcessEnv = process.env, homeDir = homedir()): RuntimeConfig {
  const agentDir = resolveAgentDir(env, homeDir);
  const stateDir = resolveStateDir(env, homeDir);
  const fileConfig = loadPersistentConfig(stateDir);
  const token = env.ONE_SIGNAL_API_TOKEN !== undefined ? env.ONE_SIGNAL_API_TOKEN : fileConfig.ONE_SIGNAL_API_TOKEN;
  const baseUrl = env.ONE_SIGNAL_BASE_URL !== undefined ? env.ONE_SIGNAL_BASE_URL : fileConfig.ONE_SIGNAL_BASE_URL;

  return {
    agentDir,
    stateDir,
    apiToken: token || undefined,
    baseUrl: resolveBaseUrl(baseUrl),
  };
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
  const config = resolveRuntimeConfig();
  if (!config.apiToken) {
    return;
  }

  const logger = createLogger();
  const queue = new DeliveryQueue({
    stateDir: config.stateDir,
    baseUrl: config.baseUrl,
    apiToken: config.apiToken,
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
      current?.onInstructionDocuments(event.systemPromptOptions.contextFiles, config.agentDir, 8_000);
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
