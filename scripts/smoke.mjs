import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

function spawnAndWait(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function withTimeout(promise, ms, onTimeout) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error(`timeout after ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const cwd = process.cwd();
  const tmpRoot = join(cwd, ".tmp", "smoke");
  const agentDir = join(tmpRoot, "pi-home");
  const stateDir = join(agentDir, "state");
  const helperExtension = join(tmpRoot, "smoke-extension.mjs");
  const requests = [];

  await rm(tmpRoot, { recursive: true, force: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    helperExtension,
    [
      "export default function (pi) {",
      '  pi.on("input", (_event, ctx) => {',
      "    ctx.shutdown();",
      '    return { action: "handled" };',
      "  });",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }

    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const version = await spawnAndWait("pi", ["--version"], { cwd });
    assert.equal(version.code, 0, `pi --version failed\n${version.stderr}`);
    assert.equal(version.stdout.trim(), "0.80.6", `expected pi 0.80.6, got ${version.stdout.trim() || "(empty)"}`);

    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const child = spawn(
      "pi",
      [
        "--approve",
        "--offline",
        "--print",
        "--extension",
        "./src/index.ts",
        "--extension",
        helperExtension,
        "smoke input",
      ],
      {
        cwd,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          ONE_SIGNAL_STATE_DIR: stateDir,
          ONE_SIGNAL_API_TOKEN: "smoke-token",
          ONE_SIGNAL_BASE_URL: baseUrl,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const run = new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        resolve({ code, signal, stdout, stderr });
      });
    });

    const result = await withTimeout(run, 15_000, () => {
      child.kill("SIGTERM");
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(result.code, 0, `pi exited with ${result.code} (${result.signal ?? "no-signal"})\n${result.stderr}`);
    assert.ok(requests.length >= 1, "expected at least one ingest request");
    assert.ok(
      requests.every((request) => request.authorization === "Bearer smoke-token"),
      "expected Authorization: Bearer smoke-token on every ingest request",
    );

    const events = requests.flatMap((request) => Array.isArray(request.body?.batch) ? request.body.batch : []);
    const sessionTraceCreates = events.filter(
      (event) => event?.type === "trace-create" && event.body?.id && event.body?.metadata?.source === "pi",
    );
    assert.ok(sessionTraceCreates.length >= 1, "expected at least one pi session trace-create");

    const firstSessionTrace = sessionTraceCreates.find((event) => typeof event.body.id === "string" && event.body.id.startsWith("session:"));
    assert.ok(firstSessionTrace, "expected a session trace id");

    const terminalUpsert = sessionTraceCreates.find(
      (event) =>
        event.body.id === firstSessionTrace.body.id &&
        typeof event.body.metadata?.session_end_reason === "string" &&
        event.body.metadata.session_end_reason.length > 0,
    );
    assert.ok(terminalUpsert, "expected terminal session trace upsert with metadata.session_end_reason");
    assert.ok(
      !events.some((event) => event?.body?.name === "Session End"),
      "did not expect a Session End observation",
    );

    console.log(
      `smoke ok: ${requests.length} request(s), ${events.length} event(s), session=${firstSessionTrace.body.id}, end=${terminalUpsert.body.metadata.session_end_reason}`,
    );
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve(undefined))));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
