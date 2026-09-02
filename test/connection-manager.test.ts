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
    expect(logs).toContain("fmsg connected as @agent@example.com");
    expect(logs.some((message) => message.startsWith("fmsg inbox catch-up complete ("))).toBe(true);
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

  it("retries an unacknowledged catch-up message after reconnect", async () => {
    server.seedMessage({
      id: 20,
      from: "@alice@example.net",
      to: ["@agent@example.com"],
      data: "retry me",
    });
    const state = new FmsgStateStore(path.join(directory, "retry-state.json"));
    await state.load();
    const controller = new AbortController();
    let attempts = 0;
    const logs: string[] = [];
    const running = runFmsgConnection({
      client: new FmsgClient(server.url, "fmsgk_agent-test", { refreshMarginMs: 0 }),
      state,
      signal: controller.signal,
      random: () => 0,
      log: { warn: (message) => logs.push(message) },
      onMessage: async (message) => {
        attempts++;
        if (attempts === 1) throw new Error("definite pre-send failure");
        await state.markProcessed(message.id);
        controller.abort();
      },
    });
    await until(() => state.hasProcessed("20"));
    await running;
    expect(attempts).toBe(2);
    expect(logs.some((message) => message.includes("definite pre-send failure"))).toBe(true);
  });

  it("recovers a persisted failed inbound even after it falls outside recent inbox pages", async () => {
    const failed = server.seedMessage({
      id: 1,
      from: "@alice@example.net",
      to: ["@agent@example.com"],
      data: "old failed delivery",
    });
    for (let id = 2; id <= 1101; id++) {
      server.seedMessage({
        id,
        from: "@alice@example.net",
        to: ["@agent@example.com"],
        data: `message ${id}`,
      });
    }
    const statePath = path.join(directory, "persisted-pending-state.json");
    const state = new FmsgStateStore(statePath);
    await state.load();
    state.assignMessage(failed, { inbound: true });
    await state.persist();
    await state.markProcessed("1101");

    const reloaded = new FmsgStateStore(statePath);
    await reloaded.load();
    const controller = new AbortController();
    const received: string[] = [];
    await runFmsgConnection({
      client: new FmsgClient(server.url, "fmsgk_agent-test", { refreshMarginMs: 0 }),
      state: reloaded,
      signal: controller.signal,
      onMessage: async (message) => {
        received.push(message.id);
        await reloaded.markProcessed(message.id);
        controller.abort();
      },
    });

    expect(received).toEqual(["1"]);
    expect(reloaded.pendingInboundIds).not.toContain("1");
  });

  it("delivers WebSocket reaction events without treating them as new messages", async () => {
    server.seedMessage({
      id: 30,
      from: "@agent@example.com",
      to: ["@alice@example.net"],
      data: "subject",
    });
    const state = new FmsgStateStore(path.join(directory, "reaction-live-state.json"));
    await state.load();
    const controller = new AbortController();
    const messages: string[] = [];
    const reactions: Array<{ id: string; source: string }> = [];
    const logs: string[] = [];
    const running = runFmsgConnection({
      client: new FmsgClient(server.url, "fmsgk_agent-test", { refreshMarginMs: 0 }),
      state,
      signal: controller.signal,
      log: { info: (message) => logs.push(message) },
      onMessage: async (message) => { messages.push(message.id); },
      onReaction: async (message, source) => {
        reactions.push({ id: message.id, source });
        await state.recordReactionSnapshot(message);
        if (source === "websocket") controller.abort();
      },
    });
    await until(() => logs.some((message) => message.startsWith("fmsg inbox catch-up complete")));
    const peer = new FmsgClient(server.url, "fmsgk_alice-test", { refreshMarginMs: 0 });
    await peer.reactToMessage("30", "👍");
    await until(() => reactions.some((entry) => entry.source === "websocket"));
    await running;
    expect(messages).toEqual([]);
    expect(reactions).toContainEqual({ id: "30", source: "websocket" });
  });

  it("synchronizes missed reactions from sent messages after reconnect", async () => {
    const subject = server.seedMessage({
      id: 31,
      from: "@agent@example.com",
      to: ["@alice@example.net"],
      data: "sent subject",
    });
    const state = new FmsgStateStore(path.join(directory, "reaction-catchup-state.json"));
    await state.load();
    await state.recordReactionSnapshot(subject, { seedIfMissing: true });
    const peer = new FmsgClient(server.url, "fmsgk_alice-test", { refreshMarginMs: 0 });
    await peer.reactToMessage("31", "❤️");
    const controller = new AbortController();
    const changes: string[] = [];
    const inboundMessages: string[] = [];
    await runFmsgConnection({
      client: new FmsgClient(server.url, "fmsgk_agent-test", { refreshMarginMs: 0 }),
      state,
      signal: controller.signal,
      onMessage: async (message) => { inboundMessages.push(message.id); },
      onReaction: async (message, source) => {
        const diff = await state.recordReactionSnapshot(message, { seedIfMissing: source === "catch-up" });
        for (const change of diff.changes) changes.push(`${change.from}:${change.emoji}`);
        controller.abort();
      },
    });
    expect(changes).toEqual(["@alice@example.net:❤️"]);
    expect(inboundMessages).toEqual([]);
  });
});
