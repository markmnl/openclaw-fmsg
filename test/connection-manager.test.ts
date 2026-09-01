import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FmsgClient } from "../src/client.js";
import { runFmsgConnection } from "../src/connection-manager.js";
import { FmsgStateStore } from "../src/state.js";
import { FakeFmsgServer } from "./fake-fmsg-server.js";

async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("fmsg WebSocket and inbox catch-up", () => {
  let server: FakeFmsgServer;
  let directory: string;

  beforeEach(async () => {
    server = new FakeFmsgServer();
    await server.start();
    directory = await mkdtemp(path.join(os.tmpdir(), "openclaw-fmsg-connection-"));
  });

  afterEach(async () => {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  });

  it("subscribes before catch-up and processes old and live messages once", async () => {
    server.seedMessage({ id: 2, from: "@alice@example.net", to: ["@agent@example.com"], data: "second" });
    server.seedMessage({ id: 1, from: "@alice@example.net", to: ["@agent@example.com"], data: "first" });
    const state = new FmsgStateStore(path.join(directory, "state.json"));
    await state.load();
    const controller = new AbortController();
    const received: string[] = [];
    const logs: string[] = [];
    let livePushed = false;
    const running = runFmsgConnection({
      client: new FmsgClient(server.url, "fmsgk_agent-test", { refreshMarginMs: 0 }),
      state,
      signal: controller.signal,
      log: { info: (message) => logs.push(message) },
      onReady: () => {
        if (livePushed) return;
        livePushed = true;
        const live = server.seedMessage({
          id: 3,
          from: "@alice@example.net",
          to: ["@agent@example.com"],
          data: "live",
        });
        server.pushNewMessage(live);
      },
      onMessage: async (message) => {
        received.push(message.id);
        await state.markProcessed(message.id);
        // Exercise shutdown while the catch-up queue is still unwinding.
        if (received.length === 3) controller.abort();
      },
    });
    await until(() => received.length === 3);
    await running;
    expect([...received].sort()).toEqual(["1", "2", "3"]);
    expect(new Set(received).size).toBe(3);
    expect(logs).toContain("fmsg connected");
  });

  it("continues the live queue after one inbound handler rejects", async () => {
    const state = new FmsgStateStore(path.join(directory, "queue-state.json"));
    await state.load();
    const controller = new AbortController();
    const received: string[] = [];
    let pushed = false;
    const running = runFmsgConnection({
      client: new FmsgClient(server.url, "fmsgk_agent-test", { refreshMarginMs: 0 }),
      state,
      signal: controller.signal,
      onReady: () => {
        if (pushed) return;
        pushed = true;
        for (const id of ["10", "11"]) {
          const message = server.seedMessage({
            id,
            from: "@alice@example.net",
            to: ["@agent@example.com"],
            data: id,
          });
          server.pushNewMessage(message);
        }
      },
      onMessage: async (message) => {
        if (message.id === "10") throw new Error("intentional handler failure");
        received.push(message.id);
        await state.markProcessed(message.id);
      },
    });
    await until(() => received.includes("11"));
    controller.abort();
    await running;
    expect(received).toEqual(["11"]);
  });
});
