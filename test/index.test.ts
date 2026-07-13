import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import oneSignalPi, { flushAndClose, resolveBaseUrl, resolveRuntimeConfig } from "../src/index.ts";

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "one-signal-pi-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeConfig(dir: string, content: string): void {
  writeFileSync(join(dir, "config.json"), content, "utf8");
}

describe("resolveBaseUrl", () => {
  it("uses the connector default when no environment override is set", () => {
    assert.equal(resolveBaseUrl(), "https://connector.1infra.io");
  });

  it("uses the explicit environment override when provided", () => {
    assert.equal(resolveBaseUrl("https://example.test"), "https://example.test");
  });
});

describe("resolveRuntimeConfig", () => {
  it("loads config.json and keeps only the supported string fields", () => {
    withTempDir((dir) => {
      writeConfig(
        dir,
        JSON.stringify({
          ONE_SIGNAL_API_TOKEN: "oc_file_token",
          ONE_SIGNAL_BASE_URL: "https://file.example.test",
          ignored: "value",
          nested: { ONE_SIGNAL_API_TOKEN: "oc_nested" },
          nonStringToken: 123,
        }),
      );

      const config = resolveRuntimeConfig({ ONE_SIGNAL_STATE_DIR: dir }, "/tmp/custom-home");

      assert.deepEqual(config, {
        agentDir: "/tmp/custom-home/.pi/agent",
        stateDir: dir,
        apiToken: "oc_file_token",
        baseUrl: "https://file.example.test",
      });
    });
  });

  it("lets environment values override file config", () => {
    withTempDir((dir) => {
      writeConfig(
        dir,
        JSON.stringify({
          ONE_SIGNAL_API_TOKEN: "oc_file_token",
          ONE_SIGNAL_BASE_URL: "https://file.example.test",
        }),
      );

      const config = resolveRuntimeConfig(
        {
          ONE_SIGNAL_STATE_DIR: dir,
          ONE_SIGNAL_API_TOKEN: "oc_env_token",
          ONE_SIGNAL_BASE_URL: "https://env.example.test",
        },
        "/tmp/custom-home",
      );

      assert.equal(config.apiToken, "oc_env_token");
      assert.equal(config.baseUrl, "https://env.example.test");
    });
  });

  it("returns an empty passive config for malformed JSON without logging source contents", () => {
    withTempDir((dir) => {
      const leakedMarker = "oc_secret_from_broken_json";
      writeConfig(dir, `{"ONE_SIGNAL_API_TOKEN":"${leakedMarker}"`);

      const calls: string[] = [];
      const originalError = console.error;
      const originalStateDir = process.env.ONE_SIGNAL_STATE_DIR;
      const originalToken = process.env.ONE_SIGNAL_API_TOKEN;
      const originalBaseUrl = process.env.ONE_SIGNAL_BASE_URL;
      console.error = (...args: unknown[]) => {
        calls.push(args.map((value) => String(value)).join(" "));
      };

      try {
        const config = resolveRuntimeConfig({ ONE_SIGNAL_STATE_DIR: dir }, "/tmp/custom-home");
        assert.deepEqual(config, {
          agentDir: "/tmp/custom-home/.pi/agent",
          stateDir: dir,
          apiToken: undefined,
          baseUrl: "https://connector.1infra.io",
        });

        const registered: string[] = [];
        process.env.ONE_SIGNAL_STATE_DIR = dir;
        delete process.env.ONE_SIGNAL_API_TOKEN;
        delete process.env.ONE_SIGNAL_BASE_URL;
        oneSignalPi({
          on(event: string) {
            registered.push(event);
          },
        } as unknown as Parameters<typeof oneSignalPi>[0]);

        assert.deepEqual(registered, []);
        assert.deepEqual(calls, []);
      } finally {
        console.error = originalError;
        if (originalStateDir === undefined) {
          delete process.env.ONE_SIGNAL_STATE_DIR;
        } else {
          process.env.ONE_SIGNAL_STATE_DIR = originalStateDir;
        }
        if (originalToken === undefined) {
          delete process.env.ONE_SIGNAL_API_TOKEN;
        } else {
          process.env.ONE_SIGNAL_API_TOKEN = originalToken;
        }
        if (originalBaseUrl === undefined) {
          delete process.env.ONE_SIGNAL_BASE_URL;
        } else {
          process.env.ONE_SIGNAL_BASE_URL = originalBaseUrl;
        }
      }
    });
  });

  it("returns an empty config when config.json is missing", () => {
    withTempDir((dir) => {
      const config = resolveRuntimeConfig({ ONE_SIGNAL_STATE_DIR: dir }, "/tmp/custom-home");

      assert.deepEqual(config, {
        agentDir: "/tmp/custom-home/.pi/agent",
        stateDir: dir,
        apiToken: undefined,
        baseUrl: "https://connector.1infra.io",
      });
    });
  });

  it("fails passive when config.json is unreadable because the path is a directory", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "config.json"));

      const config = resolveRuntimeConfig({ ONE_SIGNAL_STATE_DIR: dir }, "/tmp/custom-home");

      assert.deepEqual(config, {
        agentDir: "/tmp/custom-home/.pi/agent",
        stateDir: dir,
        apiToken: undefined,
        baseUrl: "https://connector.1infra.io",
      });
    });
  });

  it("fails passive when config.json parses to null", () => {
    withTempDir((dir) => {
      writeConfig(dir, "null");

      const config = resolveRuntimeConfig({ ONE_SIGNAL_STATE_DIR: dir }, "/tmp/custom-home");

      assert.deepEqual(config, {
        agentDir: "/tmp/custom-home/.pi/agent",
        stateDir: dir,
        apiToken: undefined,
        baseUrl: "https://connector.1infra.io",
      });
    });
  });

  it("fails passive when config.json parses to an array", () => {
    withTempDir((dir) => {
      writeConfig(dir, '["oc_file_token","https://file.example.test"]');

      const config = resolveRuntimeConfig({ ONE_SIGNAL_STATE_DIR: dir }, "/tmp/custom-home");

      assert.deepEqual(config, {
        agentDir: "/tmp/custom-home/.pi/agent",
        stateDir: dir,
        apiToken: undefined,
        baseUrl: "https://connector.1infra.io",
      });
    });
  });

  it("treats an empty environment token as an override that disables the extension", () => {
    withTempDir((dir) => {
      writeConfig(
        dir,
        JSON.stringify({
          ONE_SIGNAL_API_TOKEN: "oc_file_token",
          ONE_SIGNAL_BASE_URL: "https://file.example.test",
        }),
      );

      const config = resolveRuntimeConfig(
        {
          ONE_SIGNAL_STATE_DIR: dir,
          ONE_SIGNAL_API_TOKEN: "",
        },
        "/tmp/custom-home",
      );

      assert.equal(config.apiToken, undefined);
      assert.equal(config.baseUrl, "https://file.example.test");
    });
  });

  it("treats an empty environment base URL as an override that falls back to the connector default", () => {
    withTempDir((dir) => {
      writeConfig(
        dir,
        JSON.stringify({
          ONE_SIGNAL_API_TOKEN: "oc_file_token",
          ONE_SIGNAL_BASE_URL: "https://file.example.test",
        }),
      );

      const config = resolveRuntimeConfig(
        {
          ONE_SIGNAL_STATE_DIR: dir,
          ONE_SIGNAL_BASE_URL: "",
        },
        "/tmp/custom-home",
      );

      assert.equal(config.apiToken, "oc_file_token");
      assert.equal(config.baseUrl, "https://connector.1infra.io");
    });
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
