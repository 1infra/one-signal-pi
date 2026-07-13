import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { DeliveryQueue } from "../src/delivery.ts";

const TMP_ROOT = join(process.cwd(), ".tmp", "delivery-tests");

function event(id, output = "ok") {
  return {
    id,
    timestamp: new Date(1_720_000_000_000).toISOString(),
    type: "trace-create",
    body: {
      id: `trace-${id}`,
      name: id,
      input: null,
      output,
      metadata: {
        source: "pi",
      },
    },
  };
}

async function withServer(handler, run) {
  const hits = { count: 0 };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    hits.count += 1;
    await handler(JSON.parse(Buffer.concat(chunks).toString("utf8")), res, req);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    await run({
      url: `http://127.0.0.1:${address.port}`,
      hits,
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function waitFor(check, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`condition not met within ${timeoutMs}ms`);
}

async function scenarioPersistsAcrossRestart() {
  let first = true;
  await withServer((_body, res) => {
    if (first) {
      first = false;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "retry" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }, async ({ url }) => {
    const stateDir = join(TMP_ROOT, "restart");
    const logs = [];
    const queue1 = new DeliveryQueue({
      stateDir,
      baseUrl: url,
      apiToken: "super-secret-token",
      logger: (line) => logs.push(line),
      random: () => 0,
      backoffBaseMs: 10,
      unrefTimers: false,
    });
    await queue1.start();
    await queue1.enqueue([event("a"), event("b")]);
    await queue1.flush();

    assert.equal((await readdir(join(stateDir, "pending"))).length, 2);
    assert.ok(logs.every((line) => !line.includes("super-secret-token")));

    const queue2 = new DeliveryQueue({
      stateDir,
      baseUrl: url,
      apiToken: "super-secret-token",
      logger: (line) => logs.push(line),
      random: () => 0,
      backoffBaseMs: 10,
      unrefTimers: false,
    });
    await queue2.start();
    await queue2.flush();

    assert.equal((await readdir(join(stateDir, "pending"))).length, 0);
    queue1.close();
    queue2.close();
  });
}

async function scenarioPartialAck() {
  await withServer((_body, res) => {
    res.writeHead(207, { "content-type": "application/json" });
    res.end(JSON.stringify({
      successes: [{ id: "a" }, { id: "c" }],
      errors: [{ id: "b", status: 400, message: "bad event" }],
    }));
  }, async ({ url }) => {
    const stateDir = join(TMP_ROOT, "partial");
    const queue = new DeliveryQueue({
      stateDir,
      baseUrl: url,
      apiToken: "token",
      random: () => 0,
      unrefTimers: false,
    });
    await queue.start();
    await queue.enqueue([event("a"), event("b"), event("c")]);
    await queue.flush();

    assert.deepEqual((await readdir(join(stateDir, "pending"))).sort(), ["b.json"]);
    queue.close();
  });
}

async function scenarioUnauthorizedPause() {
  for (const status of [401, 403]) {
    await withServer((_body, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
    }, async ({ url, hits }) => {
      const logs = [];
      const stateDir = join(TMP_ROOT, `unauthorized-${status}`);
      const queue = new DeliveryQueue({
        stateDir,
        baseUrl: url,
        apiToken: "token",
        logger: (line) => logs.push(line),
        random: () => 0,
        unrefTimers: false,
      });
      await queue.start();
      await queue.enqueue([event("a")]);
      await queue.flush();
      await queue.flush();

      assert.equal(hits.count, 1);
      assert.equal((await readdir(join(stateDir, "pending"))).length, 1);
      assert.equal(logs.filter((line) => line.includes("unauthorized")).length, 1);
      queue.close();
    });
  }
}

async function scenarioRetryAfter() {
  let phase = 0;
  await withServer((_body, res) => {
    phase += 1;
    if (phase === 1) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
      res.end(JSON.stringify({ error: "slow down" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }, async ({ url, hits }) => {
    const stateDir = join(TMP_ROOT, "retry-after");
    const queue = new DeliveryQueue({
      stateDir,
      baseUrl: url,
      apiToken: "token",
      random: () => 0,
      backoffBaseMs: 10,
      unrefTimers: false,
    });
    await queue.start();
    await queue.enqueue([event("a")]);
    await Promise.all([queue.flush(), queue.flush(), queue.flush()]);
    await queue.flush();

    assert.equal(hits.count, 1);
    assert.equal((await readdir(join(stateDir, "pending"))).length, 1);

    await waitFor(async () => (await readdir(join(stateDir, "pending"))).length === 0, 1_500);
    assert.equal((await readdir(join(stateDir, "pending"))).length, 0);
    assert.equal(hits.count, 2);
    queue.close();
  });
}

async function scenarioRetriesAndSpoolLimit() {
  let timeoutHits = 0;
  await withServer(async (_body, res) => {
    timeoutHits += 1;
    if (timeoutHits === 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }, async ({ url }) => {
    const timeoutDir = join(TMP_ROOT, "timeout");
    const timeoutQueue = new DeliveryQueue({
      stateDir: timeoutDir,
      baseUrl: url,
      apiToken: "oc_super_secret",
      random: () => 0,
      requestTimeoutMs: 20,
      backoffBaseMs: 10,
      unrefTimers: false,
    });
    await timeoutQueue.start();
    await timeoutQueue.enqueue([event("timeout")]);
    await timeoutQueue.flush();
    await waitFor(async () => (await readdir(join(timeoutDir, "pending"))).length === 0);
    assert.equal(timeoutHits, 2);
    timeoutQueue.close();
  });

  let serverErrorHits = 0;
  await withServer((_body, res) => {
    serverErrorHits += 1;
    if (serverErrorHits === 1) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "retry" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }, async ({ url }) => {
    const serverErrorDir = join(TMP_ROOT, "server-error");
    const queue = new DeliveryQueue({
      stateDir: serverErrorDir,
      baseUrl: url,
      apiToken: "oc_super_secret",
      random: () => 0,
      backoffBaseMs: 10,
      unrefTimers: false,
    });
    await queue.start();
    await queue.enqueue([event("server-error")]);
    await queue.flush();
    await waitFor(async () => (await readdir(join(serverErrorDir, "pending"))).length === 0);
    assert.equal(serverErrorHits, 2);
    queue.close();
  });

  const networkDir = join(TMP_ROOT, "network");
  const networkQueue = new DeliveryQueue({
    stateDir: networkDir,
    baseUrl: "http://127.0.0.1:9",
    apiToken: "oc_super_secret",
    random: () => 0,
    backoffBaseMs: 10,
    maxSpoolBytes: 500,
    maxItemBytes: 250,
    unrefTimers: false,
  });
  await networkQueue.start();
  await networkQueue.enqueue([
    event("a", "x".repeat(600)),
    event("b", "y".repeat(600)),
    event("c", "z".repeat(600)),
  ]);
  await networkQueue.flush();

  const pendingNames = await readdir(join(networkDir, "pending"));
  assert.ok(pendingNames.length <= 2);
  for (const name of pendingNames) {
    const file = await readFile(join(networkDir, "pending", name), "utf8");
    assert.ok(file.length <= 250);
    assert.ok(!file.includes("oc_super_secret"));
  }
  networkQueue.close();
}

async function scenarioSafeFilenames() {
  await withServer((_body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }, async ({ url }) => {
    const stateDir = join(TMP_ROOT, "unsafe-id");
    const pendingDir = join(stateDir, "pending");
    const queue = new DeliveryQueue({
      stateDir,
      baseUrl: url,
      apiToken: "token",
      random: () => 0,
      unrefTimers: false,
    });
    await queue.start();
    await queue.enqueue([event("../../escape")]);

    const pendingNames = await readdir(pendingDir);
    const expected = `${createHash("sha256").update("../../escape").digest("hex")}.json`;
    assert.deepEqual(pendingNames, [expected]);
    await assert.doesNotReject(stat(join(pendingDir, expected)));
    await assert.rejects(stat(join(stateDir, "escape.json")));
    await assert.rejects(stat(join(TMP_ROOT, "escape.json")));

    const stored = JSON.parse(await readFile(join(pendingDir, expected), "utf8"));
    assert.equal(stored.id, "../../escape");
    assert.equal(stored.event.id, "../../escape");

    await queue.flush();
    assert.deepEqual(await readdir(pendingDir), []);
    queue.close();
  });
}

async function scenarioLegacyFilenameNormalization() {
  const stateDir = join(TMP_ROOT, "legacy-unsafe");
  const pendingDir = join(stateDir, "pending");
  await mkdir(pendingDir, { recursive: true });
  await writeFile(
    join(pendingDir, "legacy.json"),
    JSON.stringify({
      id: "../../escape",
      event: event("../../escape"),
      createdAt: Date.now(),
    }),
    "utf8",
  );

  const queue = new DeliveryQueue({
    stateDir,
    baseUrl: "http://127.0.0.1:9",
    apiToken: "token",
    random: () => 0,
    unrefTimers: false,
  });
  await queue.start();

  const pendingNames = await readdir(pendingDir);
  const expected = `${createHash("sha256").update("../../escape").digest("hex")}.json`;
  assert.deepEqual(pendingNames, [expected]);
  queue.close();
}

async function scenarioTempRecovery() {
  const stateDir = join(TMP_ROOT, "tmp-recovery");
  const pendingDir = join(stateDir, "pending");
  await mkdir(pendingDir, { recursive: true });

  await writeFile(
    join(pendingDir, "valid.json.tmp"),
    JSON.stringify({ id: "valid", event: event("valid"), createdAt: 1 }),
    "utf8",
  );
  await writeFile(join(pendingDir, "broken.json.tmp"), "{not-json", "utf8");

  const queue = new DeliveryQueue({
    stateDir,
    baseUrl: "http://127.0.0.1:9",
    apiToken: "token",
    random: () => 0,
    unrefTimers: false,
  });
  await queue.start();

  const names = (await readdir(pendingDir)).sort();
  assert.deepEqual(names, ["valid.json"]);
  queue.close();
}

async function main() {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });

  await scenarioPersistsAcrossRestart();
  await scenarioPartialAck();
  await scenarioUnauthorizedPause();
  await scenarioRetryAfter();
  await scenarioRetriesAndSpoolLimit();
  await scenarioSafeFilenames();
  await scenarioLegacyFilenameNormalization();
  await scenarioTempRecovery();

  await rm(TMP_ROOT, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
