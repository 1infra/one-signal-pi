import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

type QueueEvent = {
  id: string;
  timestamp: string;
  type: string;
  body: Record<string, unknown>;
};

type QueueItem = {
  id: string;
  event: QueueEvent;
  createdAt: number;
};

type QueueState = {
  seenIds: string[];
};

type QueueOptions = {
  stateDir: string;
  baseUrl: string;
  apiToken: string;
  logger?: (line: string) => void;
  random?: () => number;
  maxEventsPerBatch?: number;
  maxBatchBytes?: number;
  maxItemBytes?: number;
  maxSpoolBytes?: number;
  backoffBaseMs?: number;
  requestTimeoutMs?: number;
  unrefTimers?: boolean;
};

const DEFAULT_STATE: QueueState = { seenIds: [] };
const DEFAULT_MAX_EVENTS = 200;
const DEFAULT_MAX_BATCH_BYTES = 3_500_000;
const DEFAULT_MAX_ITEM_BYTES = 200_000;
const DEFAULT_MAX_SPOOL_BYTES = 5_000_000;
const DEFAULT_BACKOFF_BASE_MS = 500;
const SEEN_ID_LIMIT = 2_000;
const SAFE_SPOOL_ID = /^[A-Za-z0-9._-]+$/;

function hasStringId(value: unknown): value is { id: string } {
  return !!value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string";
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function spoolFilename(id: string): string {
  if (id !== "." && id !== ".." && SAFE_SPOOL_ID.test(id)) {
    return `${id}.json`;
  }
  return `${sha256(id)}.json`;
}

function spoolTempFilename(id: string): string {
  return `${spoolFilename(id)}.tmp`;
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) {
    return null;
  }
  const numeric = Number(header);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return numeric * 1_000;
  }
  const asDate = new Date(header);
  const delta = asDate.getTime() - Date.now();
  return Number.isFinite(delta) && delta > 0 ? delta : null;
}

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number, unrefTimers: boolean): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      fetch(input, init),
      new Promise<Response>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
        if (unrefTimers) {
          timer.unref();
        }
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function fitQueueItem(event: QueueEvent, createdAt: number, maxItemBytes: number): { item: QueueItem; serialized: string } | null {
  const item: QueueItem = {
    id: event.id,
    event: structuredClone(event),
    createdAt,
  };
  const serialize = (): string | null => {
    const serialized = JSON.stringify(item);
    return byteLength(serialized) <= maxItemBytes ? serialized : null;
  };

  const direct = serialize();
  if (direct) {
    return { item, serialized: direct };
  }

  if (item.event.body && typeof item.event.body === "object") {
    if ("output" in item.event.body) {
      item.event.body.output = "[truncated oversized queue item]";
    }
    if ("input" in item.event.body) {
      item.event.body.input = "[truncated oversized queue item]";
    }
    const truncatedBody = serialize();
    if (truncatedBody) {
      return { item, serialized: truncatedBody };
    }
    if ("metadata" in item.event.body) {
      item.event.body.metadata = { truncated: true };
    }
  }

  const truncatedMetadata = serialize();
  if (truncatedMetadata) {
    return { item, serialized: truncatedMetadata };
  }

  item.event = {
    id: item.event.id,
    timestamp: item.event.timestamp,
    type: item.event.type,
    body: {
      truncated: true,
      output: "[oversized queue item omitted]",
    },
  };

  const minimal = serialize();
  if (minimal) {
    return { item, serialized: minimal };
  }

  item.event = {
    id: item.id,
    timestamp: item.event.timestamp,
    type: item.event.type,
    body: {
      metadata: {
        truncated: true,
      },
    },
  };

  const smallest = serialize();
  return smallest ? { item, serialized: smallest } : null;
}

async function readJson<T>(pathname: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(pathname, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function isQueueItem(value: unknown): value is QueueItem {
  if (!value || typeof value !== "object") {
    return false;
  }
  const item = value as Partial<QueueItem>;
  return (
    typeof item.id === "string" &&
    typeof item.createdAt === "number" &&
    !!item.event &&
    typeof item.event === "object" &&
    typeof item.event.id === "string" &&
    typeof item.event.timestamp === "string" &&
    typeof item.event.type === "string" &&
    !!item.event.body &&
    typeof item.event.body === "object"
  );
}

export class DeliveryQueue {
  private readonly stateDir: string;
  private readonly pendingDir: string;
  private readonly stateFile: string;
  private readonly logger: (line: string) => void;
  private readonly random: () => number;
  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly maxEventsPerBatch: number;
  private readonly maxBatchBytes: number;
  private readonly maxItemBytes: number;
  private readonly maxSpoolBytes: number;
  private readonly backoffBaseMs: number;
  private readonly requestTimeoutMs: number;
  private readonly unrefTimers: boolean;

  private pending = new Map<string, QueueItem>();
  private seenIds = new Set<string>();
  private flushPromise: Promise<void> | null = null;
  private pausedUnauthorized = false;
  private unauthorizedLogged = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;

  constructor(options: QueueOptions) {
    this.stateDir = options.stateDir;
    this.pendingDir = join(options.stateDir, "pending");
    this.stateFile = join(options.stateDir, "state.json");
    this.logger = options.logger ?? (() => {});
    this.random = options.random ?? Math.random;
    this.baseUrl = options.baseUrl;
    this.apiToken = options.apiToken;
    this.maxEventsPerBatch = options.maxEventsPerBatch ?? DEFAULT_MAX_EVENTS;
    this.maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
    this.maxItemBytes = options.maxItemBytes ?? DEFAULT_MAX_ITEM_BYTES;
    this.maxSpoolBytes = options.maxSpoolBytes ?? DEFAULT_MAX_SPOOL_BYTES;
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
    this.unrefTimers = options.unrefTimers ?? true;
  }

  async start(): Promise<void> {
    await mkdir(this.pendingDir, { recursive: true });
    await this.recoverPendingTemps();
    const state = await readJson<QueueState>(this.stateFile, DEFAULT_STATE);
    for (const id of state.seenIds ?? []) {
      this.seenIds.add(id);
    }
    for (const name of await readdir(this.pendingDir)) {
      if (!name.endsWith(".json")) {
        continue;
      }
      await this.loadPendingFile(name);
    }
  }

  close(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  async enqueue(events: QueueEvent[]): Promise<void> {
    for (const rawEvent of events) {
      if (this.seenIds.has(rawEvent.id) || this.pending.has(rawEvent.id)) {
        continue;
      }
      const queued = fitQueueItem(rawEvent, Date.now(), this.maxItemBytes);
      if (!queued) {
        this.logger(`one-signal-pi: dropped oversized queue item ${rawEvent.id}`);
        continue;
      }
      this.pending.set(queued.item.id, queued.item);
      await this.writePending(queued.item, queued.serialized);
    }
    await this.enforceSpoolLimit();
  }

  async flush(): Promise<void> {
    if (this.pausedUnauthorized) {
      return;
    }
    if (this.retryTimer) {
      return;
    }
    if (this.flushPromise) {
      return this.flushPromise;
    }
    this.flushPromise = this.flushLoop();
    try {
      await this.flushPromise;
    } finally {
      this.flushPromise = null;
    }
  }

  private async flushLoop(): Promise<void> {
    if (this.pending.size === 0) {
      return;
    }
    const items = [...this.pending.values()].sort((a, b) => a.createdAt - b.createdAt);
    const batches = this.chunk(items);
    for (const [batchIndex, batch] of batches.entries()) {
      const outcome = await this.postBatch(batch, batches.length, batchIndex);
      if (outcome.kind === "accepted") {
        await this.acknowledge(outcome.acceptedIds);
        this.retryAttempt = 0;
        continue;
      }
      if (outcome.kind === "unauthorized") {
        this.pausedUnauthorized = true;
        if (!this.unauthorizedLogged) {
          this.unauthorizedLogged = true;
          this.logger("one-signal-pi: unauthorized ingest response; pausing retries for this runtime");
        }
        return;
      }
      if (outcome.kind === "retry") {
        const base = outcome.retryAfterMs ?? this.nextBackoffDelay();
        const jitter = outcome.retryAfterMs === null ? Math.floor(base * this.random() * 0.1) : 0;
        this.scheduleRetry(base + jitter);
        return;
      }
      if (outcome.kind === "permanent") {
        this.logger(`one-signal-pi: ingest rejected batch with HTTP ${outcome.status}`);
        this.scheduleRetry(Math.max(this.backoffBaseMs * 20, 60_000));
        return;
      }
    }
  }

  private nextBackoffDelay(): number {
    const delay = Math.min(this.backoffBaseMs * (2 ** this.retryAttempt), 30_000);
    this.retryAttempt += 1;
    return delay;
  }

  private scheduleRetry(ms: number): void {
    if (this.retryTimer) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, ms);
    if (this.unrefTimers) {
      this.retryTimer.unref();
    }
  }

  private chunk(items: QueueItem[]): QueueItem[][] {
    const groups: QueueItem[][] = [];
    let current: QueueItem[] = [];
    let currentBytes = 0;

    for (const item of items) {
      const eventBytes = byteLength(JSON.stringify(item.event));
      if (
        current.length > 0 &&
        (current.length >= this.maxEventsPerBatch || currentBytes + eventBytes > this.maxBatchBytes - 2_048)
      ) {
        groups.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(item);
      currentBytes += eventBytes;
    }

    if (current.length > 0) {
      groups.push(current);
    }
    return groups;
  }

  private async postBatch(
    batch: QueueItem[],
    batchCount: number,
    batchIndex: number,
  ): Promise<
    | { kind: "accepted"; acceptedIds: string[] }
    | { kind: "retry"; retryAfterMs: number | null }
    | { kind: "unauthorized" }
    | { kind: "permanent"; status: number }
  > {
    try {
      const response = await fetchWithTimeout(`${this.baseUrl.replace(/\/$/, "")}/api/v1/observe/ingest`, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${this.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          batch: batch.map((item) => item.event),
          metadata: {
            sdk_name: "one-signal-pi",
            sdk_version: "0.1.0",
            chunk_index: batchIndex,
            chunk_count: batchCount,
          },
        }),
      }, this.requestTimeoutMs, this.unrefTimers);

      if (response.status === 401 || response.status === 403) {
        return { kind: "unauthorized" };
      }
      if (response.status === 429) {
        return {
          kind: "retry",
          retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
        };
      }
      if (response.status >= 500) {
        return { kind: "retry", retryAfterMs: null };
      }
      if (response.status === 207) {
        const parsed = await response.json().catch(() => null);
        const successes = (
          parsed
          && typeof parsed === "object"
          && Array.isArray((parsed as { successes?: unknown }).successes)
        )
          ? (parsed as { successes: unknown[] }).successes
          : null;
        if (!successes) {
          return { kind: "retry", retryAfterMs: null };
        }
        const accepted = new Set(
          successes
            .map((entry) => (hasStringId(entry) ? entry.id : null))
            .filter(Boolean),
        );
        return {
          kind: "accepted",
          acceptedIds: batch.map((item) => item.id).filter((id) => accepted.has(id)),
        };
      }
      if (response.status >= 400) {
        return { kind: "permanent", status: response.status };
      }
      return { kind: "accepted", acceptedIds: batch.map((item) => item.id) };
    } catch (error: unknown) {
      if (error instanceof Error && (error.name === "AbortError" || error.message === "timeout")) {
        return { kind: "retry", retryAfterMs: null };
      }
      return { kind: "retry", retryAfterMs: null };
    }
  }

  private async acknowledge(ids: string[]): Promise<void> {
    for (const id of ids) {
      this.pending.delete(id);
      this.seenIds.add(id);
      await unlink(join(this.pendingDir, spoolFilename(id))).catch(() => {});
    }
    await this.saveState();
  }

  private async writePending(item: QueueItem, serialized: string): Promise<void> {
    const tmp = join(this.pendingDir, spoolTempFilename(item.id));
    const target = join(this.pendingDir, spoolFilename(item.id));
    await writeFile(tmp, serialized, "utf8");
    await rename(tmp, target);
  }

  private async recoverPendingTemps(): Promise<void> {
    for (const name of await readdir(this.pendingDir)) {
      if (!name.endsWith(".json.tmp")) {
        continue;
      }
      const tmp = join(this.pendingDir, name);
      const item = await readJson<unknown>(tmp, null);
      if (!isQueueItem(item)) {
        await rm(tmp, { force: true });
        continue;
      }
      const target = join(this.pendingDir, spoolFilename(item.id));
      const finalExists = await stat(target).then(() => true).catch(() => false);
      if (finalExists) {
        await rm(tmp, { force: true });
        continue;
      }
      await rename(tmp, target);
    }
  }

  private async saveState(): Promise<void> {
    const state: QueueState = {
      seenIds: [...this.seenIds].slice(-SEEN_ID_LIMIT),
    };
    const tmp = `${this.stateFile}.tmp`;
    await writeFile(tmp, JSON.stringify(state), "utf8");
    await rename(tmp, this.stateFile);
  }

  private async enforceSpoolLimit(): Promise<void> {
    const files = await Promise.all(
      [...this.pending.values()].map(async (item) => ({
        id: item.id,
        createdAt: item.createdAt,
        size: (await stat(join(this.pendingDir, spoolFilename(item.id)))).size,
      })),
    );
    let total = files.reduce((sum, file) => sum + file.size, 0);
    const ordered = files.sort((a, b) => a.createdAt - b.createdAt);

    for (const file of ordered) {
      if (total <= this.maxSpoolBytes) {
        break;
      }
      total -= file.size;
      this.pending.delete(file.id);
      await unlink(join(this.pendingDir, spoolFilename(file.id))).catch(() => {});
    }
  }

  private async loadPendingFile(name: string): Promise<void> {
    const path = join(this.pendingDir, name);
    const item = await readJson<unknown>(path, null);
    if (!isQueueItem(item)) {
      await rm(path, { force: true });
      return;
    }

    const normalizedName = spoolFilename(item.id);
    if (name !== normalizedName) {
      const normalizedPath = join(this.pendingDir, normalizedName);
      const normalizedExists = await stat(normalizedPath).then(() => true).catch(() => false);
      if (!normalizedExists) {
        await rename(path, normalizedPath);
      } else {
        await rm(path, { force: true });
      }
    }
    this.pending.set(item.id, item);
  }
}
