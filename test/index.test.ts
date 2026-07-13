import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { flushAndClose, resolveBaseUrl } from "../src/index.ts";

describe("resolveBaseUrl", () => {
  it("uses the connector default when no environment override is set", () => {
    assert.equal(resolveBaseUrl(), "https://connector.1infra.io");
  });

  it("uses the explicit environment override when provided", () => {
    assert.equal(resolveBaseUrl("https://example.test"), "https://example.test");
  });
});

describe("flushAndClose", () => {
  it("closes the queue after the bounded flush wait", async () => {
    let closeCount = 0;
    let flushResolved = false;
    const queue = {
      flush: () => new Promise<void>((resolve) => {
        setTimeout(() => {
          flushResolved = true;
          resolve();
        }, 50);
      }),
      close: () => {
        closeCount += 1;
      },
    };

    const pending = flushAndClose(queue, 10);

    assert.equal(closeCount, 0);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(closeCount, 1);
    assert.equal(flushResolved, false);

    await pending;
  });
});
