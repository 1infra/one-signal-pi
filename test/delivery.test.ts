import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import { join } from "node:path";

describe("DeliveryQueue", () => {
  it("passes the delivery scenarios runner", async () => {
    const runner = join(process.cwd(), "scripts", "delivery-scenarios.mjs");

    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [runner], {
        cwd: process.cwd(),
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        resolve({ code, signal, stderr });
      });
    });

    assert.equal(result.code, 0, result.stderr || `runner exited with signal ${result.signal ?? "unknown"}`);
  });
});
